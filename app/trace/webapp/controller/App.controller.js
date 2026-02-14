sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/Fragment",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "trace/model/CardanoWallet"
], function (Controller, Fragment, Filter, FilterOperator, CardanoWallet) {
  "use strict";

  return Controller.extend("trace.controller.App", {

    onInit: function () {
      var oWalletModel = this.getOwnerComponent().getModel("wallet");
      oWalletModel.setProperty("/connecting", false);
      oWalletModel.setProperty("/error", "");
      var aWallets = CardanoWallet.detect();
      oWalletModel.setProperty("/wallets", aWallets);
    },

    /** Navigate from welcome to main app */
    _navToApp: function () {
      this.byId("rootApp").to(this.byId("toolPage"));
    },

    /** Navigate back to welcome screen */
    _navToWelcome: function () {
      this.byId("rootApp").to(this.byId("welcomePage"));
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
      var oWalletModel = this.getOwnerComponent().getModel("wallet");

      if (oWalletModel.getProperty("/connected")) {
        CardanoWallet.disconnect();
        oWalletModel.setProperty("/connected", false);
        oWalletModel.setProperty("/name", "");
        oWalletModel.setProperty("/address", "");
        oWalletModel.setProperty("/bech32", "");
        oWalletModel.setProperty("/vkh", "");
        oWalletModel.setProperty("/participantId", "");
        oWalletModel.setProperty("/participantName", "");
        this._navToWelcome();
        return;
      }

      // Show wallet selection popover (for header button reconnect)
      var oButton = oEvent.getSource();
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

    onWelcomeWalletSelect: function (oEvent) {
      var oItem = oEvent.getParameter("listItem");
      var sWalletId = oItem.getBindingContext("wallet").getProperty("id");
      var oWalletModel = this.getOwnerComponent().getModel("wallet");
      var that = this;

      oWalletModel.setProperty("/connecting", true);
      oWalletModel.setProperty("/error", "");

      CardanoWallet.connect(sWalletId)
        .then(function (oInfo) {
          oWalletModel.setProperty("/connected", true);
          oWalletModel.setProperty("/name", oInfo.name);
          oWalletModel.setProperty("/address", oInfo.address);
          oWalletModel.setProperty("/bech32", oInfo.bech32);
          oWalletModel.setProperty("/vkh", oInfo.vkh);
          oWalletModel.setProperty("/participantId", "");
          oWalletModel.setProperty("/participantName", "");
          oWalletModel.setProperty("/connecting", false);
          that._resolveParticipantFromVkh(oInfo.vkh);
          that._navToApp();
          sap.m.MessageToast.show("Connected to " + oInfo.name);
        })
        .catch(function (err) {
          oWalletModel.setProperty("/connecting", false);
          oWalletModel.setProperty("/error", "Connection failed: " + err.message);
        });
    },

    onWalletSelect: function (oEvent) {
      var sWalletName = oEvent.getSource().data("walletName");
      var oWalletModel = this.getOwnerComponent().getModel("wallet");
      var that = this;

      CardanoWallet.connect(sWalletName)
        .then(function (oInfo) {
          oWalletModel.setProperty("/connected", true);
          oWalletModel.setProperty("/name", oInfo.name);
          oWalletModel.setProperty("/address", oInfo.address);
          oWalletModel.setProperty("/bech32", oInfo.bech32);
          oWalletModel.setProperty("/vkh", oInfo.vkh);
          oWalletModel.setProperty("/participantId", "");
          oWalletModel.setProperty("/participantName", "");
          that._resolveParticipantFromVkh(oInfo.vkh);
          if (that._pWalletPopover) {
            that._pWalletPopover.then(function (p) { p.close(); });
          }
          that._navToApp();
          sap.m.MessageToast.show("Connected to " + oInfo.name);
        })
        .catch(function (err) {
          sap.m.MessageBox.error("Wallet connection failed: " + err.message);
        });
    },

    _resolveParticipantFromVkh: function (sVkh) {
      if (!sVkh) { return; }

      var oModel = this.getOwnerComponent().getModel();
      var oWalletModel = this.getOwnerComponent().getModel("wallet");

      var oListBinding = oModel.bindList("/Participants", null, null, [
        new Filter("vkh", FilterOperator.EQ, sVkh),
        new Filter("isActive", FilterOperator.EQ, true)
      ]);

      oListBinding.requestContexts(0, 1).then(function (aContexts) {
        if (aContexts.length > 0) {
          oWalletModel.setProperty("/participantId", aContexts[0].getProperty("ID"));
          oWalletModel.setProperty("/participantName", aContexts[0].getProperty("name"));
        }
      });
    }
  });
});
