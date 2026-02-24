sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/Fragment",
  "sap/m/MessageBox",
  "sap/m/MessageToast",
  "sap/ui/model/json/JSONModel",
  "../model/CardanoWallet"
], function (Controller, Fragment, MessageBox, MessageToast, JSONModel, CardanoWallet) {
  "use strict";

  return Controller.extend("trace.controller.Participants", {

    onParticipantPress: function (oEvent) {
      var oContext = oEvent.getSource().getBindingContext();
      var sParticipantId = oContext.getProperty("ID");
      this.getOwnerComponent().getRouter().navTo("participantDetail", { participantId: sParticipantId });
    },

    onRefresh: function () {
      this.byId("participantTable").getBinding("items").refresh();
      MessageToast.show("Refreshed");
    },

    onAddressChange: function (oEvent) {
      var oContext = oEvent.getSource().getBindingContext();
      if (!oContext) return;
      var sAddress = oEvent.getParameter("value") || "";
      var sVkh = CardanoWallet.bech32ToVkh(sAddress);
      oContext.setProperty("vkh", sVkh);
    },

    onFieldChange: function () {
      // Changes are tracked by the OData v4 model automatically
      // They'll be submitted on Save
    },

    onDelete: function (oEvent) {
      var oContext = oEvent.getSource().getBindingContext();
      var sName = oContext.getProperty("name") || "this participant";

      MessageBox.confirm("Delete " + sName + "?", {
        onClose: function (sAction) {
          if (sAction === MessageBox.Action.OK) {
            oContext.delete();
            MessageToast.show("Deleted");
          }
        }
      });
    },

    onSave: function () {
      var oModel = this.getView().getModel();
      oModel.submitBatch(oModel.getUpdateGroupId()).then(function () {
        MessageToast.show("Changes saved");
      }).catch(function (err) {
        MessageBox.error("Save failed: " + err.message);
      });
    },

    onDiscard: function () {
      var oModel = this.getView().getModel();
      oModel.resetChanges();
      MessageToast.show("Changes discarded");
    },

    // -----------------------------------------------------------------
    // Add Participant flow (on behalf — mints NFT to their wallet)
    // -----------------------------------------------------------------

    onAdd: function () {
      var oWalletModel = this.getOwnerComponent().getModel("wallet");

      if (!oWalletModel.getProperty("/connected")) {
        MessageBox.warning("Please connect your Cardano wallet first.");
        return;
      }

      var oAddModel = new JSONModel({
        name: "",
        role: "Manufacturer",
        address: "",
        vkh: ""
      });
      this.getView().setModel(oAddModel, "addParticipant");

      if (!this._pAddDialog) {
        this._pAddDialog = Fragment.load({
          id: this.getView().getId(),
          name: "trace.fragment.AddParticipantDialog",
          controller: this
        }).then(function (oDialog) {
          this.getView().addDependent(oDialog);
          return oDialog;
        }.bind(this));
      }

      this._pAddDialog.then(function (oDialog) {
        oDialog.open();
      });
    },

    onAddParticipantAddressChange: function (oEvent) {
      var sAddress = oEvent.getParameter("value") || "";
      var oAddModel = this.getView().getModel("addParticipant");
      var sVkh = CardanoWallet.bech32ToVkh(sAddress);
      oAddModel.setProperty("/vkh", sVkh);
    },

    onAddParticipantConfirm: function () {
      var oAddModel = this.getView().getModel("addParticipant");
      var sName = (oAddModel.getProperty("/name") || "").trim();
      var sRole = oAddModel.getProperty("/role");
      var sAddress = (oAddModel.getProperty("/address") || "").trim();
      var sVkh = oAddModel.getProperty("/vkh") || "";

      if (!sName) {
        MessageBox.warning("Please enter the participant's name.");
        return;
      }
      if (!sAddress) {
        MessageBox.warning("Please enter the participant's Cardano address.");
        return;
      }
      if (!sVkh) {
        MessageBox.warning("Could not derive VKH from the address. Please check the address format.");
        return;
      }

      this._pAddDialog.then(function (d) { d.close(); });
      this._signAndSubmitAdd(sName, sRole, sAddress, sVkh);
    },

    onAddParticipantCancel: function () {
      this._pAddDialog.then(function (d) { d.close(); });
    },

    _signAndSubmitAdd: function (sName, sRole, sAddress, sVkh) {
      var oModel = this.getView().getModel();
      var that = this;

      var oActionBinding = oModel.bindContext("/AddParticipant(...)");
      oActionBinding.setParameter("name", sName);
      oActionBinding.setParameter("role", sRole);
      oActionBinding.setParameter("participantAddress", sAddress);
      oActionBinding.setParameter("participantVkh", sVkh);
      oActionBinding.setParameter("walletAddress", CardanoWallet.getAddress());
      oActionBinding.setParameter("walletVkh", CardanoWallet.getVkh());

      MessageToast.show("Building registration transaction...");

      oActionBinding.execute()
        .then(function () {
          var oResult = oActionBinding.getBoundContext().getObject();
          MessageToast.show("Sign with your wallet to mint registration NFT...");
          return CardanoWallet.signTx(oResult.unsignedCbor).then(function (sSignedCbor) {
            return {
              signingRequestId: oResult.signingRequestId,
              signedCbor: sSignedCbor
            };
          });
        })
        .then(function (oSigned) {
          MessageToast.show("Submitting transaction...");
          var oSubmitBinding = oModel.bindContext("/SubmitSigned(...)");
          oSubmitBinding.setParameter("signingRequestId", oSigned.signingRequestId);
          oSubmitBinding.setParameter("signedTxCbor", oSigned.signedCbor);
          return oSubmitBinding.execute().then(function () {
            return oSubmitBinding.getBoundContext().getObject();
          });
        })
        .then(function (oSubmit) {
          MessageToast.show("Participant added! Tx: " + (oSubmit.txHash || "").substring(0, 16) + "...");
          that.byId("participantTable").getBinding("items").refresh();
        })
        .catch(function (err) {
          var sMsg = err.message || String(err);
          if (sMsg.indexOf("User") >= 0 || sMsg.indexOf("refused") >= 0) {
            MessageToast.show("Cancelled by user");
          } else {
            MessageBox.error("Add participant failed: " + sMsg);
          }
          that.byId("participantTable").getBinding("items").refresh();
        });
    },

    // -----------------------------------------------------------------
    // Registration flow (self-service)
    // -----------------------------------------------------------------

    onRegister: function () {
      var oWalletModel = this.getOwnerComponent().getModel("wallet");

      if (!oWalletModel.getProperty("/connected")) {
        MessageBox.warning("Please connect your Cardano wallet first.");
        return;
      }

      var oRegisterModel = new JSONModel({
        name: "",
        role: "Manufacturer",
        walletAddress: oWalletModel.getProperty("/bech32"),
        walletVkh: oWalletModel.getProperty("/vkh")
      });
      this.getView().setModel(oRegisterModel, "registerForm");

      if (!this._pRegisterDialog) {
        this._pRegisterDialog = Fragment.load({
          id: this.getView().getId(),
          name: "trace.fragment.RegisterParticipantDialog",
          controller: this
        }).then(function (oDialog) {
          this.getView().addDependent(oDialog);
          return oDialog;
        }.bind(this));
      }

      this._pRegisterDialog.then(function (oDialog) {
        oDialog.open();
      });
    },

    onRegisterConfirm: function () {
      var oRegisterModel = this.getView().getModel("registerForm");
      var sName = (oRegisterModel.getProperty("/name") || "").trim();
      var sRole = oRegisterModel.getProperty("/role");

      if (!sName) {
        MessageBox.warning("Please enter your name.");
        return;
      }

      this._pRegisterDialog.then(function (d) { d.close(); });
      this._signAndSubmitRegistration(sName, sRole);
    },

    onRegisterCancel: function () {
      this._pRegisterDialog.then(function (d) { d.close(); });
    },

    _signAndSubmitRegistration: function (sName, sRole) {
      var oModel = this.getView().getModel();
      var oWalletModel = this.getOwnerComponent().getModel("wallet");
      var that = this;

      var oActionBinding = oModel.bindContext("/RegisterParticipant(...)");
      oActionBinding.setParameter("name", sName);
      oActionBinding.setParameter("role", sRole);
      oActionBinding.setParameter("walletAddress", CardanoWallet.getAddress());
      oActionBinding.setParameter("walletVkh", CardanoWallet.getVkh());

      MessageToast.show("Building registration transaction...");

      oActionBinding.execute()
        .then(function () {
          var oResult = oActionBinding.getBoundContext().getObject();
          MessageToast.show("Sign with your wallet to complete registration...");
          return CardanoWallet.signTx(oResult.unsignedCbor).then(function (sSignedCbor) {
            return {
              signingRequestId: oResult.signingRequestId,
              signedCbor: sSignedCbor,
              participantId: oResult.participantId
            };
          });
        })
        .then(function (oSigned) {
          MessageToast.show("Submitting registration transaction...");
          var oSubmitBinding = oModel.bindContext("/SubmitSigned(...)");
          oSubmitBinding.setParameter("signingRequestId", oSigned.signingRequestId);
          oSubmitBinding.setParameter("signedTxCbor", oSigned.signedCbor);
          return oSubmitBinding.execute().then(function () {
            return {
              submit: oSubmitBinding.getBoundContext().getObject(),
              participantId: oSigned.participantId
            };
          });
        })
        .then(function (oFinal) {
          MessageToast.show("Registration submitted! Tx: " + (oFinal.submit.txHash || "").substring(0, 16) + "...");
          oWalletModel.setProperty("/participantId", oFinal.participantId);
          oWalletModel.setProperty("/participantName", sName);
          that.byId("participantTable").getBinding("items").refresh();
        })
        .catch(function (err) {
          var sMsg = err.message || String(err);
          if (sMsg.indexOf("User") >= 0 || sMsg.indexOf("refused") >= 0) {
            MessageToast.show("Registration cancelled by user");
          } else {
            MessageBox.error("Registration failed: " + sMsg);
          }
          that.byId("participantTable").getBinding("items").refresh();
        });
    },

    formatRegistrationState: function (sStatus) {
      switch (sStatus) {
        case "CONFIRMED":  return "Success";
        case "SUBMITTED":  return "Warning";
        case "PENDING":    return "None";
        case "FAILED":     return "Error";
        default:           return "None";
      }
    }
  });
});
