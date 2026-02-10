sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/m/MessageBox",
  "sap/m/MessageToast",
  "../model/CardanoWallet"
], function (Controller, MessageBox, MessageToast, CardanoWallet) {
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

    onAdd: function () {
      var oListBinding = this.byId("participantTable").getBinding("items");
      oListBinding.create({
        name: "",
        role: "Manufacturer",
        address: "",
        vkh: "",
        isActive: true
      });
      MessageToast.show("New row added — fill in details and Save");
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
    }
  });
});
