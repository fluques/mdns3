include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-mdns3
PKG_VERSION:=1.0
PKG_RELEASE:=2

include $(INCLUDE_DIR)/package.mk

define Package/luci-app-mdns3
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=3. Applications
  TITLE:=LuCI mDNS3 Application
  DEPENDS:=+luci-base
  PKGARCH:=all
endef

define Build/Compile
	# No binary C code compilation needed, interpreted code only
endef

define Package/luci-app-mdns3/install
	# 1. Install view JavaScript file
	$(INSTALL_DIR) $(1)/www/luci-static/resources/view
	$(CP) $$(shell find ./htdocs/ -name "*.js") $(1)/www/luci-static/resources/view/

	# 2. Install uci-defaults scripts
	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(CP) $(PKG_BUILD_DIR)/root/etc/uci-defaults/* $(1)/etc/uci-defaults/ 2>/dev/null || $(CP) ./root/etc/uci-defaults/* $(1)/etc/uci-defaults/

	# 3. Install LuCI JSON menu definitions
	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(CP) ./root/usr/share/luci/menu.d/* $(1)/usr/share/luci/menu.d/

	# 4. Install rpcd ACL permission files
	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(CP) ./root/usr/share/rpcd/acl.d/* $(1)/usr/share/rpcd/acl.d/
endef

$(eval $(call BuildPackage,luci-app-mdns3))
