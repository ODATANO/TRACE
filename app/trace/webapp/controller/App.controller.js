sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/Fragment",
  "trace/model/CardanoWallet"
], function (Controller, Fragment, CardanoWallet) {
  "use strict";

  return Controller.extend("trace.controller.App", {

    onInit: function () {
      // Detect available wallets on load
      var oWalletModel = this.getOwnerComponent().getModel("wallet");
      var aWallets = CardanoWallet.detect();
      oWalletModel.setProperty("/wallets", aWallets);
    },

    onToggleMenu: function () {
      var oToolPage = this.byId("toolPage");
      oToolPage.setSideExpanded(!oToolPage.getSideExpanded());
    },

    onNavSelect: function (oEvent) {
      var sKey = oEvent.getParameter("item").getKey();
      var oRouter = this.getOwnerComponent().getRouter();
      oRouter.navTo(sKey);
    },

    onWalletPress: function (oEvent) {
      var oButton = oEvent.getSource();
      var oWalletModel = this.getOwnerComponent().getModel("wallet");

      if (oWalletModel.getProperty("/connected")) {
        // Disconnect
        CardanoWallet.disconnect();
        oWalletModel.setProperty("/connected", false);
        oWalletModel.setProperty("/name", "");
        oWalletModel.setProperty("/address", "");
        return;
      }

      // Show wallet selection popover
      if (!this._pWalletPopover) {
        this._pWalletPopover = Fragment.load({
          id: this.getView().getId(),
          name: "trace.fragment.WalletConnect",
          controller: this
        }).then(function (oPopover) {
          this.getView().addDependent(oPopover);
          return oPopover;
        }.bind(this));
      }

      this._pWalletPopover.then(function (oPopover) {
        oPopover.openBy(oButton);
      });
    },

    onWalletSelect: function (oEvent) {
      var sWalletName = oEvent.getSource().data("walletName");
      var oWalletModel = this.getOwnerComponent().getModel("wallet");

      CardanoWallet.connect(sWalletName)
        .then(function (oInfo) {
          oWalletModel.setProperty("/connected", true);
          oWalletModel.setProperty("/name", oInfo.name);
          oWalletModel.setProperty("/address", oInfo.address);
          if (this._pWalletPopover) {
            this._pWalletPopover.then(function (p) { p.close(); });
          }
          sap.m.MessageToast.show("Connected to " + oInfo.name);
        }.bind(this))
        .catch(function (err) {
          sap.m.MessageBox.error("Wallet connection failed: " + err.message);
        });
    }
  });
});
