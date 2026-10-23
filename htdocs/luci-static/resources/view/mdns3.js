'use strict';
/* global L, E, _ */

return L.view.extend({
	parsedOptions: [],
	parsedRules: [],
	currentConfDir: '/etc/mdns3.d', // Persistent protected path
	targetFile: 'mdns3_servers.conf',
	rulesFile: 'mdns3_rules.conf',
	
	// Application switch state
	isAppEnabled: false,

	// Convert "a.b.c.d" to integer; returns null if not a valid IPv4 address
	ipToInt: function(ip) {
		var parts = String(ip || '').trim().split('.');
		if (parts.length !== 4) return null;
		var n = 0;
		for (var i = 0; i < 4; i++) {
			if (!/^\d{1,3}$/.test(parts[i])) return null;
			var octet = parseInt(parts[i], 10);
			if (octet > 255) return null;
			n = n * 256 + octet;
		}
		return n;
	},

	// Detect inverted ranges (start > end) and overlaps between rules on the same VLAN
	findRuleConflicts: function() {
		var self = this, errors = [], bad = {};
		var ranges = self.parsedRules.map(function(r, i) {
			return { idx: i, rule: r, s: self.ipToInt(r.start_ip), e: self.ipToInt(r.end_ip) };
		});

		ranges.forEach(function(a) {
			if (a.s === null) {
				bad[a.idx] = true;
				errors.push(_('Rule %d (%s): start IP "%s" is not a valid IPv4 address.')
					.format(a.idx + 1, a.rule.vlan, a.rule.start_ip || ''));
			}
			if (a.e === null) {
				bad[a.idx] = true;
				errors.push(_('Rule %d (%s): end IP "%s" is not a valid IPv4 address.')
					.format(a.idx + 1, a.rule.vlan, a.rule.end_ip || ''));
			}
			if (a.s !== null && a.e !== null && a.s > a.e) {
				bad[a.idx] = true;
				errors.push(_('Rule %d (%s): start IP %s is greater than end IP %s.')
					.format(a.idx + 1, a.rule.vlan, a.rule.start_ip, a.rule.end_ip));
			}
		});

		for (var i = 0; i < ranges.length; i++) {
			for (var j = i + 1; j < ranges.length; j++) {
				var a = ranges[i], b = ranges[j];
				if (a.rule.vlan !== b.rule.vlan) continue;
				if (a.s === null || a.e === null || b.s === null || b.e === null) continue;
				if (a.s > a.e || b.s > b.e) continue;
				if (a.s <= b.e && b.s <= a.e) {
					bad[a.idx] = true;
					bad[b.idx] = true;
					errors.push(_('Rule %d (%s %s - %s) overlaps with rule %d (%s - %s).')
						.format(a.idx + 1, a.rule.vlan, a.rule.start_ip, a.rule.end_ip,
						        b.idx + 1, b.rule.start_ip, b.rule.end_ip));
				}
			}
		}

		return { errors: errors, bad: bad };
	},

	load: function() {
		var self = this;
		
		return L.require('fs').then(function(fs_module) {
			self.fs = fs_module;

			// 1. Read switch state (on / off) and sync with actual dnsmasq configuration
			return L.resolveDefault(self.fs.read('/etc/config/dhcp.mode'), '').then(function(modeContent) {
				// 2. Always load standard /etc/config/dhcp file
				return L.uci.load('dhcp').then(function() {
					var sections = L.uci.sections('dhcp', 'dnsmasq');
					if (sections.length > 0 && sections[0].confdir) {
						self.isAppEnabled = true;
						self.currentConfDir = sections[0].confdir;
					} else {
						self.isAppEnabled = (modeContent.trim() === 'on');
					}
					
					var pathServers = self.currentConfDir + '/' + self.targetFile;
					var pathRules = self.currentConfDir + '/' + self.rulesFile;

					return Promise.all([
						L.resolveDefault(self.fs.read(pathServers), ''),
						L.resolveDefault(self.fs.read(pathRules), '')
					]).then(function(contents) {
						var serverContent = contents[0];
						var rulesContent = contents[1];

						var serverLines = (serverContent && typeof serverContent === 'string') ? serverContent.split(/\r?\n/) : [];
						self.parsedOptions = [];
						var detectedTags = [];

						for (var i = 0; i < serverLines.length; i++) {
							var line = serverLines[i].trim();
							var match = line.match(/^dhcp-option\s*=\s*tag\s*:\s*([^,\s]+)\s*,\s*6\s*,\s*([^,\s]+)/);
							if (match) {
								self.parsedOptions.push({ tag: match[1], dns: match[2] });
								if (detectedTags.indexOf(match[1]) === -1) {
									detectedTags.push(match[1]);
								}
							}
						}

						var ruleLines = (rulesContent && typeof rulesContent === 'string') ? rulesContent.split(/\r?\n/) : [];
						self.parsedRules = [];

						for (var j = 0; j < ruleLines.length; j++) {
							var rLine = ruleLines[j].trim();
							if (rLine.length > 0 && !rLine.startsWith('#')) {
								var rMatch = rLine.match(/^dhcp-range\s*=\s*interface\s*:\s*([^,\s]+)\s*,\s*set\s*:\s*([^,\s]+)\s*,\s*([^,\s]+)\s*,\s*([^,\s]+)\s*,\s*([^,\s]+)\s*,\s*([^,\s]+)/);
								if (rMatch) {
									self.parsedRules.push({
										vlan: rMatch[1], 
										tag: rMatch[2],
										start_ip: rMatch[3],
										end_ip: rMatch[4],
										netmask: rMatch[5],
										leasetime: rMatch[6]
									});
								}
							}
						}
						
						var availableVlans = [];
						var dhcpSections = L.uci.sections('dhcp', 'dhcp');
						dhcpSections.forEach(function(s) {
							if (s.interface && s.ignore !== '1') {
								availableVlans.push(s.interface);
							}
						});

						return {
							tags: detectedTags,
							vlans: availableVlans
						};
					});
				});
			});
		}).catch(function(error) {
			console.error("Error reading files", error);
			return { tags: [], vlans: [] };
		});
	},
	render: function(data) {
		var self = this;
		var availableTags = data.tags || [];
		var availableVlans = data.vlans || [];

		// Visual configuration for ON / OFF Switch (button displays the opposite action to current state)
		var modeButtonText = self.isAppEnabled ? _('TURN OFF') : _('TURN ON');
		var modeAlertClass = self.isAppEnabled ? 'alert-message success' : 'alert-message warning';
		var modeDescriptionText = self.isAppEnabled 
			? _('Application ENABLED (ON): dnsmasq uses confdir %s and start/limit/leasetime were removed from available DHCP interfaces.').format(self.currentConfDir) 
			: _('Application DISABLED (OFF). Interface in READ-ONLY mode. Enable the application to make changes.');

		// Default OpenWrt values restored when turning the application off
		var DHCP_DEFAULTS = { start: '100', limit: '150', leasetime: '12h' };

		var btnToggleMode = E('button', {
			'class': self.isAppEnabled ? 'btn cbi-button-reset' : 'btn cbi-button-apply',
			'style': 'margin-bottom: 10px; font-weight: bold;',
			'click': function(ev) {
				ev.preventDefault();

				var enable = !self.isAppEnabled;

				// 1. confdir on main dnsmasq section
				var dnsmasqSections = L.uci.sections('dhcp', 'dnsmasq');
				if (dnsmasqSections.length > 0) {
					var mainDnsmasqName = dnsmasqSections[0]['.name'];
					if (enable)
						L.uci.set('dhcp', mainDnsmasqName, 'confdir', self.currentConfDir);
					else
						L.uci.unset('dhcp', mainDnsmasqName, 'confdir');
				}

				// 2. start / limit / leasetime on available DHCP interfaces (same filter as VLAN list)
				L.uci.sections('dhcp', 'dhcp').forEach(function(s) {
					if (!s.interface || s.ignore === '1')
						return;

					Object.keys(DHCP_DEFAULTS).forEach(function(opt) {
						if (enable)
							L.uci.unset('dhcp', s['.name'], opt);
						else
							L.uci.set('dhcp', s['.name'], opt, DHCP_DEFAULTS[opt]);
					});
				});

				// 3. Save mode state, save UCI changes and apply them (commit + dnsmasq reload via procd)
				return L.require('ui').then(function(ui) {
					return self.fs.write('/etc/config/dhcp.mode', enable ? 'on' : 'off').then(function() {
						return L.uci.save();
					}).then(function() {
						return L.uci.changes();
					}).then(function(changes) {
						if (changes && Object.keys(changes).length > 0)
							return ui.changes.apply(true);

						window.location.reload();
					}).catch(function(err) {
						ui.addNotification(null, E('p', {}, _('Error changing application state: ') + (err.message || err)), 'error');
					});
				});
			}
		}, [ modeButtonText ]);

		var environmentPanel = E('div', { 'class': modeAlertClass, 'style': 'margin-bottom: 20px; display: flex; align-items: center; justify-content: space-between;' }, [
			E('p', { 'style': 'margin: 0;' }, [
				E('strong', {}, _('Switch Status: ')),
				modeDescriptionText
			]),
			btnToggleMode
		]);
		// Container and rows for DNS Servers (Tags)
		var dnsTableRowsContainer = E('tbody');
		var renderRuleRows;

		// Rebuild available tags list from DNS servers table and refresh rules table
		var syncAvailableTags = function() {
			availableTags = [];
			self.parsedOptions.forEach(function(o) {
				var t = (o.tag || '').trim();
				if (t && availableTags.indexOf(t) === -1) {
					availableTags.push(t);
				}
			});
			self.parsedRules.forEach(function(r) {
				if (availableTags.length > 0 && availableTags.indexOf(r.tag) === -1) {
					r.tag = availableTags[0];
				} else if (availableTags.length === 0) {
					r.tag = '';
				}
			});
			if (typeof renderRuleRows === 'function') {
				renderRuleRows();
			}
		};

		var renderDnsRows = function() {
			while (dnsTableRowsContainer.firstChild) {
				dnsTableRowsContainer.removeChild(dnsTableRowsContainer.firstChild);
			}

			if (self.parsedOptions.length === 0) {
				dnsTableRowsContainer.appendChild(E('tr', { 'class': 'cbi-section-table-row placeholder' }, [
					E('td', { 'colspan': '3', 'style': 'padding: 15px; text-align: center;' }, _('-- No DNS servers found. Use the "Add" button --'))
				]));
				return;
			}

			self.parsedOptions.forEach(function(opt, index) {
				var tagOpt = { 'type': 'text', 'class': 'cbi-input-text', 'value': opt.tag, 'style': 'width:95%' };
				var dnsOpt = { 'type': 'text', 'class': 'cbi-input-text', 'value': opt.dns, 'placeholder': '1.1.1.1', 'style': 'width:95%' };
				
				if (!self.isAppEnabled) {
					tagOpt.disabled = 'disabled';
					dnsOpt.disabled = 'disabled';
				}

				var tagInput = E('input', tagOpt);
				var dnsInput = E('input', dnsOpt);

				if (self.ipToInt(opt.dns) === null) {
					dnsInput.classList.add('cbi-input-invalid');
					dnsInput.title = _('Enter a valid IPv4 address (e.g. 1.1.1.1)');
				}

				var validateDnsInput = function(ev) {
					var val = ev.target.value.trim();
					self.parsedOptions[index].dns = val;
					if (self.ipToInt(val) !== null) {
						dnsInput.classList.remove('cbi-input-invalid');
						dnsInput.removeAttribute('title');
					} else {
						dnsInput.classList.add('cbi-input-invalid');
						dnsInput.title = _('Enter a valid IPv4 address (e.g. 1.1.1.1)');
					}
				};

				var updateTagName = function(ev) {
					var oldTag = self.parsedOptions[index].tag;
					var newTag = ev.target.value.trim();
					self.parsedOptions[index].tag = newTag;
					if (oldTag && newTag && oldTag !== newTag) {
						self.parsedRules.forEach(function(r) {
							if (r.tag === oldTag) r.tag = newTag;
						});
					}
					syncAvailableTags();
				};

				tagInput.addEventListener('input', updateTagName);
				tagInput.addEventListener('change', updateTagName);
				dnsInput.addEventListener('input', validateDnsInput);
				dnsInput.addEventListener('change', validateDnsInput);

				var btnDeleteOpt = { 'class': 'btn cbi-button-remove' };
				if (!self.isAppEnabled) btnDeleteOpt.disabled = 'disabled';

				var btnDelete = E('button', btnDeleteOpt, [ _('Delete') ]);
				btnDelete.addEventListener('click', function(ev) {
					ev.preventDefault();
					self.parsedOptions.splice(index, 1);
					renderDnsRows();
					syncAvailableTags();
				});

				dnsTableRowsContainer.appendChild(E('tr', { 'class': 'tr cbi-section-table-row' }, [
					E('td', { 'class': 'td', 'style': 'width: 45%; vertical-align: middle;' }, tagInput),
					E('td', { 'class': 'td', 'style': 'width: 40%; vertical-align: middle;' }, dnsInput),
					E('td', { 'class': 'td cbi-section-actions', 'style': 'width: 15%; vertical-align: middle;' }, btnDelete)
				]));
			});
		};

		var btnAddDnsOpt = { 'class': 'btn cbi-button-add', 'style': 'margin-bottom: 15px;' };
		if (!self.isAppEnabled) btnAddDnsOpt.disabled = 'disabled';

		var btnAddDns = E('button', btnAddDnsOpt, [ _('Add DNS Server') ]);
		btnAddDns.addEventListener('click', function(ev) {
			ev.preventDefault();
			var baseTag = 'new_tag';
			var candidate = baseTag;
			var counter = 2;
			while (availableTags.indexOf(candidate) !== -1) {
				candidate = baseTag + '_' + counter++;
			}
			self.parsedOptions.push({ tag: candidate, dns: '1.1.1.1' });
			renderDnsRows();
			syncAvailableTags();
		});

		renderDnsRows();

		var headerAlertServers = E('div', { 'class': 'alert-message info', 'style': 'margin-bottom: 15px;' }, [
			E('p', {}, [
				E('strong', {}, _('Monitored Servers Path: ')),
				E('code', { 'style': 'padding: 3px 6px; border-radius: 3px; color: #c7254e;' }, self.currentConfDir + '/' + self.targetFile)
			])
		]);

		var tagsTabContainer = E('div', {}, [
			headerAlertServers,
			E('div', { 'class': 'cbi-section' }, [
				btnAddDns,
				E('table', { 'class': 'table cbi-section-table', 'style': 'width:100%; border-collapse: collapse; margin-top:10px;' }, [
					E('thead', {}, [
						E('tr', { 'class': 'tr cbi-section-table-titles' }, [
							E('th', { 'class': 'th', 'style': 'width: 45%; text-align: left; font-weight: bold;' }, _('Tag')),
							E('th', { 'class': 'th', 'style': 'width: 40%; text-align: left; font-weight: bold;' }, _('Associated DNS Server')),
							E('th', { 'class': 'th cbi-section-actions', 'style': 'width: 15%; text-align: left; font-weight: bold;' }, _('Actions'))
						])
					]),
					dnsTableRowsContainer
				])
			])
		]);
		// Container and rows for DHCP Ranges (Rules)
		var rulesTableRowsContainer = E('tbody');
		var dragSrcEl = null;
		var ruleRows = [];

		// Highlight rows in red when ranges overlap (same VLAN) or start > end
		var markRuleConflicts = function() {
			var bad = self.findRuleConflicts().bad;
			ruleRows.forEach(function(row, i) {
				if (bad[i]) {
					row.style.backgroundColor = 'rgba(220, 53, 69, 0.15)';
					row.title = _('Invalid range or overlaps with another rule on the same VLAN');
				} else {
					row.style.backgroundColor = '';
					row.removeAttribute('title');
				}
			});
		};

		renderRuleRows = function() {
			ruleRows = [];
			while (rulesTableRowsContainer.firstChild) {
				rulesTableRowsContainer.removeChild(rulesTableRowsContainer.firstChild);
			}

			if (self.parsedRules.length === 0) {
				rulesTableRowsContainer.appendChild(E('tr', { 'class': 'cbi-section-table-row placeholder' }, [
					E('td', { 'colspan': '7', 'style': 'padding: 15px; text-align: center;' }, _('-- No DHCP rules found. Use the "Add" button --'))
				]));
				return;
			}

			self.parsedRules.forEach(function(rule, index) {
				var vlanSelectOpt = { 'class': 'cbi-input-select', 'style': 'width:95%' };
				if (!self.isAppEnabled) vlanSelectOpt.disabled = 'disabled';
				var vlanSelect = E('select', vlanSelectOpt);
				
				if (availableVlans.length === 0) {
					vlanSelect.appendChild(E('option', { 'value': '' }, _('None (lan)')));
				} else {
					availableVlans.forEach(function(v) {
						var opt = { 'value': v };
						if (rule.vlan === v) opt.selected = 'selected';
						vlanSelect.appendChild(E('option', opt, v));
					});
				}
				vlanSelect.addEventListener('change', function(ev) { self.parsedRules[index].vlan = ev.target.value; markRuleConflicts(); });

				var setupIpInput = function(field, placeholder) {
					var inputOpt = { 'type': 'text', 'class': 'cbi-input-text', 'value': rule[field] || '', 'placeholder': placeholder, 'style': 'width:90%' };
					if (!self.isAppEnabled) inputOpt.disabled = 'disabled';
					var input = E('input', inputOpt);

					if (self.ipToInt(rule[field]) === null) {
						input.classList.add('cbi-input-invalid');
						input.title = _('Enter a valid IPv4 address');
					}

					var validateRuleIp = function(ev) {
						var val = ev.target.value.trim();
						self.parsedRules[index][field] = val;
						if (self.ipToInt(val) !== null) {
							input.classList.remove('cbi-input-invalid');
							input.removeAttribute('title');
						} else {
							input.classList.add('cbi-input-invalid');
							input.title = _('Enter a valid IPv4 address');
						}
						markRuleConflicts();
					};
					
					input.addEventListener('input', validateRuleIp);
					input.addEventListener('change', validateRuleIp);
					return input;
				};

				var startIpInput = setupIpInput('start_ip', '192.168.1.10');
				var endIpInput = setupIpInput('end_ip', '192.168.1.50');
				var maskInput = setupIpInput('netmask', '255.255.255.0');

				var leaseSelectOpt = { 'class': 'cbi-input-select', 'style': 'width:95%' };
				if (!self.isAppEnabled) leaseSelectOpt.disabled = 'disabled';
				var leaseSelect = E('select', leaseSelectOpt);
				var times = ['6h', '12h', '48h', 'infinite'];
				times.forEach(function(t) {
					var opt = { 'value': t };
					if (rule.leasetime === t) opt.selected = 'selected';
					leaseSelect.appendChild(E('option', opt, t));
				});
				leaseSelect.addEventListener('change', function(ev) { self.parsedRules[index].leasetime = ev.target.value; });

				var tagSelectOpt = { 'class': 'cbi-input-select', 'style': 'width:95%' };
				if (!self.isAppEnabled) tagSelectOpt.disabled = 'disabled';
				var tagSelect = E('select', tagSelectOpt);
				if (availableTags.length === 0) {
					tagSelect.appendChild(E('option', { 'value': '' }, _('-- No Tags --')));
				} else {
					availableTags.forEach(function(t) {
						var opt = { 'value': t };
						if (rule.tag === t) opt.selected = 'selected';
						tagSelect.appendChild(E('option', opt, t));
					});
				}
				tagSelect.addEventListener('change', function(ev) { self.parsedRules[index].tag = ev.target.value; });

				var btnDeleteRuleOpt = { 'class': 'btn cbi-button-remove' };
				if (!self.isAppEnabled) btnDeleteRuleOpt.disabled = 'disabled';
				var btnDeleteRule = E('button', btnDeleteRuleOpt, [ _('Delete') ]);
				btnDeleteRule.addEventListener('click', function(ev) {
					ev.preventDefault();
					self.parsedRules.splice(index, 1);
					renderRuleRows();
				});

				var dragHandle = E('span', { 'style': 'cursor: grab; font-size: 1.3em; margin-right: 12px; color: #888; user-select: none;' }, '☰');

				var rowOpt = { 'class': 'tr cbi-section-table-row' };
				if (self.isAppEnabled) rowOpt.draggable = 'true';
				var row = E('tr', rowOpt, [
					E('td', { 'class': 'td', 'style': 'vertical-align: middle;' }, vlanSelect),
					E('td', { 'class': 'td', 'style': 'vertical-align: middle;' }, startIpInput),
					E('td', { 'class': 'td', 'style': 'vertical-align: middle;' }, endIpInput),
					E('td', { 'class': 'td', 'style': 'vertical-align: middle;' }, maskInput),
					E('td', { 'class': 'td', 'style': 'vertical-align: middle;' }, leaseSelect),
					E('td', { 'class': 'td', 'style': 'vertical-align: middle;' }, tagSelect),
					E('td', { 'class': 'td cbi-section-actions', 'style': 'vertical-align: middle; display: flex; flex-direction: row; align-items: center; justify-content: flex-start; height: 100%; border: none;' }, [dragHandle, btnDeleteRule])
				]);

				if (self.isAppEnabled) {
					row.addEventListener('dragstart', function(e) { dragSrcEl = index; row.style.opacity = '0.5'; e.dataTransfer.effectAllowed = 'move'; });
					row.addEventListener('dragover', function(e) { if (e.preventDefault) e.preventDefault(); return false; });
					row.addEventListener('drop', function(e) {
						e.stopPropagation();
						if (dragSrcEl !== index) {
							var removed = self.parsedRules.splice(dragSrcEl, 1)[0];
							self.parsedRules.splice(index, 0, removed);
							renderRuleRows();
						}
						return false;
					});
					row.addEventListener('dragend', function() { row.style.opacity = '1.0'; });
				}
				rulesTableRowsContainer.appendChild(row);
				ruleRows.push(row);
			});
			markRuleConflicts();
		};

		var btnAddRuleOpt = { 'class': 'btn cbi-button-add', 'style': 'margin-bottom: 15px;' };
		if (!self.isAppEnabled) btnAddRuleOpt.disabled = 'disabled';
		var btnAddRule = E('button', btnAddRuleOpt, [ _('Add DHCP Range') ]);
		btnAddRule.addEventListener('click', function(ev) {
			ev.preventDefault();
			var defaultTag = availableTags.length > 0 ? availableTags[0] : 'new_tag';
			var defaultVlan = availableVlans.length > 0 ? availableVlans[0] : 'lan';
			var startIp = '192.168.1.10';
			var endIp = '192.168.1.50';

			// If rules already exist on this VLAN, suggest the next free block to avoid immediate overlap
			var maxEnd = null, prefix = null;
			self.parsedRules.forEach(function(r) {
				if (r.vlan === defaultVlan) {
					var eInt = self.ipToInt(r.end_ip);
					if (eInt !== null && (maxEnd === null || eInt > maxEnd)) {
						maxEnd = eInt;
						var parts = r.end_ip.trim().split('.');
						prefix = parts.slice(0, 3).join('.');
					}
				}
			});
			if (maxEnd !== null && prefix) {
				var lastOctet = maxEnd % 256;
				if (lastOctet < 254) {
					var nextStart = lastOctet + 1;
					var nextEnd = Math.min(254, nextStart + 39);
					startIp = prefix + '.' + nextStart;
					endIp = prefix + '.' + nextEnd;
				}
			}

			self.parsedRules.push({ vlan: defaultVlan, start_ip: startIp, end_ip: endIp, netmask: '255.255.255.0', leasetime: '12h', tag: defaultTag });
			renderRuleRows();
		});

		renderRuleRows();

		var headerAlertRules = E('div', { 'class': 'alert-message info', 'style': 'margin-bottom: 15px;' }, [
			E('p', {}, [
				E('strong', {}, _('Monitored Rules Path: ')),
				E('code', { 'style': 'padding: 3px 6px; border-radius: 3px; color: #c7254e;' }, self.currentConfDir + '/' + self.rulesFile)
			])
		]);

		var rulesTabContainer = E('div', {}, [
			headerAlertRules,
			E('div', { 'class': 'cbi-section' }, [
				btnAddRule,
				E('table', { 'class': 'table cbi-section-table', 'style': 'width: 100%; border-collapse: collapse; margin-top:10px; table-layout: auto;' }, [
					E('thead', {}, [
						E('tr', { 'class': 'tr cbi-section-table-titles' }, [
							E('th', { 'style': 'text-align: left; font-weight: bold;' }, _('VLAN (DHCP)')),
							E('th', { 'style': 'text-align: left; font-weight: bold;' }, _('Start IP')),
							E('th', { 'style': 'text-align: left; font-weight: bold;' }, _('End IP')),
							E('th', { 'style': 'text-align: left; font-weight: bold;' }, _('Netmask')),
							E('th', { 'style': 'text-align: left; font-weight: bold;' }, _('Lease Time')),
							E('th', { 'style': 'text-align: left; font-weight: bold;' }, _('DNS Tag')),
							E('th', { 'class': 'cbi-section-actions', 'style': 'text-align: left; font-weight: bold;' }, _('Actions'))
						])
					]),
					rulesTableRowsContainer
				])
			])
		]);
		// Final integration of Control Panel and LuCI Map
		var containerViewForm = E('div', {}, [
			environmentPanel,
			E('div', { 'id': 'cbi-map-dhcp-container' })
		]);

		var m = new L.form.Map('dhcp', _('mDNS3'), _('Tag-based DHCP / DNS Server Configuration'));
		
		// Disable bottom native LuCI buttons when app is OFF
		if (!self.isAppEnabled) {
			m.readonly = true;
		}

		var s = m.section(L.form.TypedSection, 'dnsmasq', '');
		s.anonymous = true; s.addremove = false;
		s.tab('dns_servers', _('Tags')); s.tab('host_tags', _('Rules'));

		var o1 = s.taboption('dns_servers', L.form.DummyValue, '_dns_table');
		o1.rawhtml = true; o1.render = function() { return tagsTabContainer; };

		var oRules = s.taboption('host_tags', L.form.DummyValue, '_rules_table');
		oRules.rawhtml = true; oRules.render = function() { return rulesTabContainer; };

		m.render().then(function(mapNode) {
			containerViewForm.querySelector('#cbi-map-dhcp-container').appendChild(mapNode);
		});

		return containerViewForm;
	},

	handleSaveApply: function(ev, mode) {
		var self = this;
		
		// Extra safeguard at save level
		if (!self.isAppEnabled) {
			return Promise.reject(new Error(_('Saving configuration is not allowed while the application is disabled.')));
		}

		// Do not save if there are invalid DNS Server IPs or invalid/overlapping ranges in Rules
		var validationErrors = [];
		self.parsedOptions.forEach(function(opt, idx) {
			if (self.ipToInt(opt.dns) === null) {
				validationErrors.push(_('DNS Server %d (%s): IP "%s" is not a valid IPv4 address.')
					.format(idx + 1, opt.tag || _('untagged'), opt.dns || ''));
			}
		});
		var conflicts = self.findRuleConflicts();
		validationErrors = validationErrors.concat(conflicts.errors);
		if (validationErrors.length > 0) {
			return L.require('ui').then(function(ui) {
				ui.addNotification(_('Changes were not saved'),
					E('div', {}, validationErrors.map(function(msg) { return E('p', {}, msg); })), 'error');
			});
		}

		var pathServers = self.currentConfDir + '/' + self.targetFile;
		var pathRules = self.currentConfDir + '/' + self.rulesFile;

		var serversContent = '';
		self.parsedOptions.forEach(function(opt) {
			if (opt.tag && opt.dns) serversContent += 'dhcp-option=tag:' + opt.tag + ',6,' + opt.dns + '\n';
		});

		// Rules are saved ONLY in mdns3_rules.conf (dnsmasq reads them via confdir).
		// /etc/config/dhcp is not modified here; only the ON/OFF button modifies it.
		var rulesContent = '';
		self.parsedRules.forEach(function(rule) {
			if (rule.vlan && rule.tag && rule.start_ip && rule.end_ip && rule.netmask && rule.leasetime) {
				var lineStr = 'dhcp-range=interface:' + rule.vlan + ',set:' + rule.tag + ',' + rule.start_ip + ',' + rule.end_ip + ',' + rule.netmask + ',' + rule.leasetime;
				rulesContent += '# Conditional DHCP range per interface\n' + lineStr + '\n';
			}
		});

		return Promise.all([
			self.fs.write(pathServers, serversContent),
			self.fs.write(pathRules, rulesContent)
		]).then(function() {
			// Restart dnsmasq so it re-reads confdir files (without UCI commit)
			return L.require('rpc').then(function(rpc_module) {
				var callInitAction = rpc_module.declare({
					object: 'system', method: 'init_action', params: [ 'name', 'action' ], expect: { 'result': 0 }
				});
				return L.resolveDefault(callInitAction('dnsmasq', 'restart'), '');
			}).then(function() {
				L.require('ui').then(function(ui) {
					ui.addNotification(null, E('p', {}, _('Changes saved and applied successfully.')), 'info');
				});
			});
		}).catch(function(err) {
			L.require('ui').then(function(ui) {
				ui.addNotification(null, E('p', {}, _('Error saving network configuration: ') + err.message), 'error');
			});
		});
	}
});
