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
        mineCount: 0,
        incomingCount: 0,
        searchQuery: ""
      }), "viewModel");

      // Suspend list bindings until participantId is available
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
      ["batchTableMine", "batchTableIncoming"].forEach(function (sId) {
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

      if (sId.indexOf("batchTableMine") > -1) {
        oViewModel.setProperty("/mineCount", iTotal);
      } else if (sId.indexOf("batchTableIncoming") > -1) {
        oViewModel.setProperty("/incomingCount", iTotal);
      }
    },

    // ---- Counter Bootstrap ----

    onInitCounter: function () {
      if (!CardanoWallet.isConnected()) {
        MessageBox.warning("Please connect your Cardano wallet first.");
        return;
      }

      var sVkh = CardanoWallet.getVkh();
      var that = this;

      MessageBox.confirm(
        "Initialise the on-chain manufacturer counter for the connected wallet?\n\n" +
        "This is a one-shot bootstrap and consumes one UTxO as a seed. " +
        "You only need to run it once before minting any batches.",
        {
          title: "Init Manufacturer Counter",
          onClose: function (sAction) {
            if (sAction !== MessageBox.Action.OK) { return; }
            that._signAndSubmit("InitManufacturerCounter", {}).then(function (oRes) {
              if (oRes && oRes.txHash) {
                MessageBox.information(
                  "Counter bootstrap submitted.\n\n" +
                  "Tx: " + oRes.txHash + "\n\n" +
                  "Wait for confirmation before minting a batch."
                );
              }
            });
          }
        }
      );
    },

    _signAndSubmit: function (sActionName, oPayload) {
      if (!CardanoWallet.isConnected()) {
        MessageBox.warning("Please connect your Cardano wallet first.");
        return Promise.reject(new Error("Wallet not connected"));
      }

      oPayload.walletAddress = CardanoWallet.getAddress();
      oPayload.walletVkh = CardanoWallet.getVkh();

      var oModel = this.getView().getModel();
      var oActionBinding = oModel.bindContext("/" + sActionName + "(...)");
      Object.keys(oPayload).forEach(function (sKey) {
        oActionBinding.setParameter(sKey, oPayload[sKey]);
      });

      MessageToast.show("Building transaction...");

      return oActionBinding.execute()
        .then(function () {
          var oResult = oActionBinding.getBoundContext().getObject();
          MessageToast.show("Signing with wallet...");
          return CardanoWallet.signTx(oResult.unsignedCbor).then(function (sSignedCbor) {
            return { signingRequestId: oResult.signingRequestId, signedCbor: sSignedCbor };
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
        .then(function (oSubmitResult) {
          MessageToast.show("Transaction submitted! Hash: " + (oSubmitResult.txHash || "").substring(0, 16) + "...");
          return oSubmitResult;
        })
        .catch(function (err) {
          if (err.message && err.message.indexOf("User") >= 0) {
            MessageToast.show("Signing cancelled by user");
          } else {
            MessageBox.error("Transaction failed: " + (err.message || err));
          }
          throw err;
        });
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
        var oListBinding = that.byId("batchTableMine").getBinding("items");

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
        var oListBinding = that.byId("batchTableMine").getBinding("items");

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
