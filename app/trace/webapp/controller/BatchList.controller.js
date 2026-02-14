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

    onInit: function () {
      // Local view model for tab counts and search state
      this.getView().setModel(new JSONModel({
        allCount: 0,
        mineCount: 0,
        incomingCount: 0,
        searchQuery: ""
      }), "viewModel");

      // Suspend wallet-gated list bindings until participantId is available
      var that = this;
      this.getView().attachAfterRendering(function () {
        that._suspendList("batchTableMine");
        that._suspendList("batchTableIncoming");
      });

      // Watch for wallet participantId changes to apply/refresh filters
      this.getOwnerComponent().getModel("wallet")
        .attachPropertyChange(this._onWalletChanged.bind(this));

      // Re-apply filters when navigating back to this page
      this.getOwnerComponent().getRouter()
        .getRoute("batches")
        .attachPatternMatched(this._onRouteMatched, this);
    },

    _onRouteMatched: function () {
      this._applyTabFilters();
    },

    _onWalletChanged: function () {
      // Debounce since multiple properties change at once on connect/disconnect
      clearTimeout(this._walletChangeTimer);
      this._walletChangeTimer = setTimeout(this._applyTabFilters.bind(this), 100);
    },

    // ---- Filter Logic ----

    _applyTabFilters: function () {
      var oWalletModel = this.getOwnerComponent().getModel("wallet");
      var sParticipantId = oWalletModel.getProperty("/participantId");
      var sSearchQuery = this.getView().getModel("viewModel").getProperty("/searchQuery");

      // Tab: All — search filter only
      this._applyFilterToList("batchTableAll", [], sSearchQuery);

      // Tab: My Batches
      if (sParticipantId) {
        this._applyFilterToList("batchTableMine", [
          new Filter("manufacturer_ID", FilterOperator.EQ, sParticipantId)
        ], sSearchQuery);
      } else {
        this._suspendList("batchTableMine");
      }

      // Tab: Incoming Transfers
      if (sParticipantId) {
        this._applyFilterToList("batchTableIncoming", [
          new Filter("currentHolder_ID", FilterOperator.EQ, sParticipantId),
          new Filter("status", FilterOperator.EQ, "IN_TRANSIT")
        ], sSearchQuery);
      } else {
        this._suspendList("batchTableIncoming");
      }

      // If wallet disconnected and on a wallet-gated tab, switch back to "all"
      if (!sParticipantId) {
        var oTabBar = this.byId("batchIconTabBar");
        if (oTabBar && oTabBar.getSelectedKey() !== "all") {
          oTabBar.setSelectedKey("all");
        }
      }
    },

    _applyFilterToList: function (sListId, aTabFilters, sSearchQuery) {
      var oList = this.byId(sListId);
      if (!oList) { return; }

      var oBinding = oList.getBinding("items");
      if (!oBinding) { return; }

      var aFilters = aTabFilters.slice();
      if (sSearchQuery) {
        aFilters.push(new Filter({
          filters: [
            new Filter("batchNumber", FilterOperator.Contains, sSearchQuery),
            new Filter("product", FilterOperator.Contains, sSearchQuery)
          ],
          and: false
        }));
      }

      if (oBinding.isSuspended()) {
        oBinding.resume();
      }
      oBinding.filter(aFilters);
    },

    _suspendList: function (sListId) {
      var oList = this.byId(sListId);
      if (!oList) { return; }

      var oBinding = oList.getBinding("items");
      if (oBinding && !oBinding.isSuspended()) {
        oBinding.suspend();
      }
    },

    _buildSearchFilter: function (sQuery) {
      return new Filter({
        filters: [
          new Filter("batchNumber", FilterOperator.Contains, sQuery),
          new Filter("product", FilterOperator.Contains, sQuery)
        ],
        and: false
      });
    },

    // ---- Formatters ----

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

    formatHasParticipant: function (sParticipantId) {
      return !!sParticipantId;
    },

    // ---- Event Handlers ----

    onTabSelect: function (oEvent) {
      var sKey = oEvent.getParameter("key");
      // Re-apply filters for the newly selected tab (ensures resume if suspended)
      this._applyTabFilters();
    },

    onBatchPress: function (oEvent) {
      var oItem = oEvent.getParameter("listItem") || oEvent.getSource();
      var sBatchId = oItem.getBindingContext().getProperty("ID");
      this.getOwnerComponent().getRouter().navTo("batchDetail", { batchId: sBatchId });
    },

    onSearch: function (oEvent) {
      var sQuery = oEvent.getParameter("newValue");
      this.getView().getModel("viewModel").setProperty("/searchQuery", sQuery);
      this._applyTabFilters();
    },

    onRefresh: function () {
      // Refresh all non-suspended lists
      ["batchTableAll", "batchTableMine", "batchTableIncoming"].forEach(function (sId) {
        var oList = this.byId(sId);
        if (oList) {
          var oBinding = oList.getBinding("items");
          if (oBinding && !oBinding.isSuspended()) {
            oBinding.refresh();
          }
        }
      }.bind(this));
      MessageToast.show("Refreshed");
    },

    onListUpdateFinished: function (oEvent) {
      var oSource = oEvent.getSource();
      var iTotal = oEvent.getParameter("total") || 0;
      var sId = oSource.getId();
      var oViewModel = this.getView().getModel("viewModel");

      if (sId.indexOf("batchTableAll") > -1) {
        oViewModel.setProperty("/allCount", iTotal);
      } else if (sId.indexOf("batchTableMine") > -1) {
        oViewModel.setProperty("/mineCount", iTotal);
      } else if (sId.indexOf("batchTableIncoming") > -1) {
        oViewModel.setProperty("/incomingCount", iTotal);
      }
    },

    // ---- Batch Creation ----

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

      this._resolveManufacturer().then(function (sParticipantId) {
        var oListBinding = that.byId("batchTableAll").getBinding("items");

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
        var oListBinding = that.byId("batchTableAll").getBinding("items");

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
