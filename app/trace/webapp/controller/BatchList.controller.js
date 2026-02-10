sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/Fragment",
  "sap/m/MessageBox",
  "sap/m/MessageToast",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/ui/model/json/JSONModel",
  "../model/CardanoWallet"
], function (Controller, Fragment, MessageBox, MessageToast, Filter, FilterOperator, JSONModel, CardanoWallet) {
  "use strict";

  return Controller.extend("trace.controller.BatchList", {

    formatStatusState: function (sStatus) {
      switch (sStatus) {
        case "DRAFT":      return "None";
        case "MINTED":     return "Success";
        case "IN_TRANSIT":  return "Warning";
        case "DELIVERED":  return "Success";
        case "RECALLED":   return "Error";
        default:           return "None";
      }
    },

    formatStatusIcon: function (sStatus) {
      switch (sStatus) {
        case "DRAFT":      return "sap-icon://document";
        case "MINTED":     return "sap-icon://create-form";
        case "IN_TRANSIT":  return "sap-icon://shipping-status";
        case "DELIVERED":  return "sap-icon://accept";
        case "RECALLED":   return "sap-icon://alert";
        default:           return "sap-icon://question-mark";
      }
    },

    onBatchPress: function (oEvent) {
      var oItem = oEvent.getParameter("listItem") || oEvent.getSource();
      var sBatchId = oItem.getBindingContext().getProperty("ID");
      this.getOwnerComponent().getRouter().navTo("batchDetail", { batchId: sBatchId });
    },

    onSearch: function (oEvent) {
      var sQuery = oEvent.getParameter("newValue");
      var aFilters = [];
      if (sQuery) {
        aFilters.push(new Filter({
          filters: [
            new Filter("batchNumber", FilterOperator.Contains, sQuery),
            new Filter("product", FilterOperator.Contains, sQuery)
          ],
          and: false
        }));
      }
      this.byId("batchTable").getBinding("items").filter(aFilters);
    },

    onRefresh: function () {
      this.byId("batchTable").getBinding("items").refresh();
      MessageToast.show("Refreshed");
    },

    onCreateBatch: function () {
      var that = this;

      if (!this._pCreateDialog) {
        this._pCreateDialog = Fragment.load({
          id: this.getView().getId(),
          name: "trace.fragment.CreateBatchDialog",
          controller: this
        }).then(function (oDialog) {
          that.getView().addDependent(oDialog);
          return oDialog;
        });
      }

      // Generate a batch number
      var sDate = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      var sSeq = String(Date.now()).slice(-4);

      var oNewBatchModel = new JSONModel({
        batchNumber: "BATCH-" + sDate + "-" + sSeq,
        product: "",
        dosageForm: "Tablet",
        mfgDate: "",
        expDate: "",
        quantity: "",
        unit: "pcs",
        storageConditions: ""
      });
      this.getView().setModel(oNewBatchModel, "newBatch");

      this._pCreateDialog.then(function (oDialog) {
        oDialog.open();
      });
    },

    onCreateBatchConfirm: function () {
      var oData = this.getView().getModel("newBatch").getData();

      // Validate required fields
      if (!oData.product) {
        MessageBox.error("Product Name is required.");
        return;
      }
      if (!oData.mfgDate) {
        MessageBox.error("Manufacturing Date is required.");
        return;
      }
      if (!oData.expDate) {
        MessageBox.error("Expiry Date is required.");
        return;
      }
      if (!oData.quantity || isNaN(Number(oData.quantity))) {
        MessageBox.error("Quantity must be a number.");
        return;
      }

      // Build originPayload
      var oPayload = {
        product: oData.product,
        batch: oData.batchNumber,
        dosageForm: oData.dosageForm,
        mfgDate: oData.mfgDate,
        expDate: oData.expDate,
        quantity: Number(oData.quantity),
        unit: oData.unit
      };
      if (oData.storageConditions) {
        oPayload.storageConditions = oData.storageConditions;
      }

      // Try to auto-set manufacturer from connected wallet
      var that = this;
      var oModel = this.getView().getModel();

      this._resolveManufacturer().then(function (sParticipantId) {
        var oListBinding = that.byId("batchTable").getBinding("items");

        var oEntry = {
          batchNumber: oData.batchNumber,
          product: oData.product,
          status: "DRAFT",
          originPayload: JSON.stringify(oPayload)
        };

        if (sParticipantId) {
          oEntry.manufacturer_ID = sParticipantId;
          oEntry.currentHolder_ID = sParticipantId;
        }

        var oContext = oListBinding.create(oEntry);

        oContext.created().then(function () {
          MessageToast.show("Batch created");
          var sBatchId = oContext.getProperty("ID");
          that.getOwnerComponent().getRouter().navTo("batchDetail", { batchId: sBatchId });
        }).catch(function (err) {
          MessageBox.error("Failed to create batch: " + (err.message || String(err)));
        });

        // Close dialog
        that.byId("createBatchDialog").close();

      }).catch(function () {
        // No wallet or no matching participant — create without manufacturer
        var oListBinding = that.byId("batchTable").getBinding("items");

        var oContext = oListBinding.create({
          batchNumber: oData.batchNumber,
          product: oData.product,
          status: "DRAFT",
          originPayload: JSON.stringify(oPayload)
        });

        oContext.created().then(function () {
          MessageToast.show("Batch created (manufacturer not auto-set — connect wallet)");
          var sBatchId = oContext.getProperty("ID");
          that.getOwnerComponent().getRouter().navTo("batchDetail", { batchId: sBatchId });
        }).catch(function (err) {
          MessageBox.error("Failed to create batch: " + (err.message || String(err)));
        });

        that.byId("createBatchDialog").close();
      });
    },

    onCreateBatchCancel: function () {
      this.byId("createBatchDialog").close();
    },

    /**
     * Resolve the connected wallet's VKH to a Participant ID.
     * Returns a promise that resolves with the participant ID or rejects.
     */
    _resolveManufacturer: function () {
      if (!CardanoWallet.isConnected()) {
        return Promise.reject("Wallet not connected");
      }

      var sVkh = CardanoWallet.getVkh();
      if (!sVkh) {
        return Promise.reject("No VKH");
      }

      var oModel = this.getView().getModel();
      var oListBinding = oModel.bindList("/Participants", null, null, [
        new Filter("vkh", FilterOperator.EQ, sVkh),
        new Filter("isActive", FilterOperator.EQ, true)
      ]);

      return oListBinding.requestContexts(0, 1).then(function (aContexts) {
        if (aContexts.length > 0) {
          return aContexts[0].getProperty("ID");
        }
        return Promise.reject("No matching participant for VKH " + sVkh);
      });
    }
  });
});
