sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator"
], function (Controller, Filter, FilterOperator) {
  "use strict";

  return Controller.extend("trace.controller.ParticipantDetail", {

    onInit: function () {
      this.getOwnerComponent().getRouter()
        .getRoute("participantDetail")
        .attachPatternMatched(this._onRouteMatched, this);
    },

    _onRouteMatched: function (oEvent) {
      var sParticipantId = oEvent.getParameter("arguments").participantId;
      var sPath = "/Participants(" + sParticipantId + ")";

      this.getView().bindElement({ path: sPath });

      // Filter batches table to show only this participant's batches
      var oTable = this.byId("participantBatchesTable");
      var oBinding = oTable.getBinding("items");
      if (oBinding) {
        oBinding.filter([
          new Filter("currentHolder_ID", FilterOperator.EQ, sParticipantId)
        ]);
      }
    },

    onNavBack: function () {
      this.getOwnerComponent().getRouter().navTo("participants");
    },

    onBatchPress: function (oEvent) {
      var oItem = oEvent.getParameter("listItem") || oEvent.getSource();
      var sBatchId = oItem.getBindingContext().getProperty("ID");
      this.getOwnerComponent().getRouter().navTo("batchDetail", { batchId: sBatchId });
    },

    formatStatusState: function (sStatus) {
      switch (sStatus) {
        case "DRAFT":      return "None";
        case "MINTED":     return "Success";
        case "IN_TRANSIT":  return "Warning";
        case "DELIVERED":  return "Success";
        case "RECALLED":   return "Error";
        default:           return "None";
      }
    }
  });
});
