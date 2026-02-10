sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/Fragment",
  "sap/m/MessageBox",
  "sap/m/MessageToast",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "trace/model/CardanoWallet"
], function (Controller, Fragment, MessageBox, MessageToast, JSONModel, Filter, FilterOperator, CardanoWallet) {
  "use strict";

  return Controller.extend("trace.controller.BatchDetail", {

    onInit: function () {
      // Local model for parsed originPayload fields
      this.getView().setModel(new JSONModel({}), "batchInfo");

      this.getOwnerComponent().getRouter()
        .getRoute("batchDetail")
        .attachPatternMatched(this._onRouteMatched, this);
    },

    _onRouteMatched: function (oEvent) {
      var sBatchId = oEvent.getParameter("arguments").batchId;
      var sPath = "/Batches(" + sBatchId + ")";

      this.getView().bindElement({
        path: sPath,
        parameters: {
          $expand: "manufacturer,currentHolder,onChainAsset,proofEvents,documentAnchors"
        },
        events: {
          dataReceived: this._onBatchDataLoaded.bind(this)
        }
      });

      // Also try loading immediately if data is already cached
      var that = this;
      var oBinding = this.getView().getElementBinding();
      if (oBinding) {
        oBinding.attachEventOnce("dataReceived", function () {
          that._parseBatchInfo();
        });
      }
    },

    _onBatchDataLoaded: function () {
      this._parseBatchInfo();
    },

    /**
     * Parse originPayload JSON string into the batchInfo JSON model.
     */
    _parseBatchInfo: function () {
      var oContext = this.getView().getBindingContext();
      if (!oContext) return;

      var sPayload = oContext.getProperty("originPayload");
      var oInfo = {};

      if (sPayload) {
        try {
          oInfo = JSON.parse(sPayload);
        } catch (e) {
          oInfo = {};
        }
      }

      // Fill defaults for display
      if (!oInfo.product) oInfo.product = oContext.getProperty("product") || "";
      if (!oInfo.dosageForm) oInfo.dosageForm = "";
      if (!oInfo.mfgDate) oInfo.mfgDate = "";
      if (!oInfo.expDate) oInfo.expDate = "";
      if (!oInfo.quantity) oInfo.quantity = "";
      if (!oInfo.unit) oInfo.unit = "pcs";
      if (!oInfo.storageConditions) oInfo.storageConditions = "";

      this.getView().getModel("batchInfo").setData(oInfo);
    },

    onNavBack: function () {
      this.getOwnerComponent().getRouter().navTo("batches");
    },

    // --- Formatters ---

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

    formatEventStatus: function (sStatus) {
      switch (sStatus) {
        case "CONFIRMED":  return "Success";
        case "SUBMITTED":  return "Warning";
        case "PENDING":    return "None";
        case "FAILED":     return "Error";
        default:           return "None";
      }
    },

    // --- Supply Chain Progress Bar Colors ---

    formatStep1Color: function (sStatus) {
      // Manufactured: green once minted, red if recalled
      if (sStatus === "RECALLED") return "#BB0000";
      if (sStatus !== "DRAFT") return "#107E3E";
      return "#89919A";
    },

    formatStep2Color: function (sStatus) {
      // In Distribution: green if in transit or beyond, red if recalled
      if (sStatus === "RECALLED") return "#BB0000";
      if (sStatus === "IN_TRANSIT" || sStatus === "DELIVERED") return "#107E3E";
      return "#89919A";
    },

    formatStep3Color: function (sStatus) {
      // Delivered: green only if delivered, red if recalled
      if (sStatus === "RECALLED") return "#BB0000";
      if (sStatus === "DELIVERED") return "#107E3E";
      return "#89919A";
    },

    // --- Batch Info Save ---

    onSaveBatchInfo: function () {
      var oContext = this.getView().getBindingContext();
      if (!oContext) return;

      var oInfo = this.getView().getModel("batchInfo").getData();

      if (!oInfo.product) {
        MessageBox.error("Product Name is required.");
        return;
      }

      // Build the originPayload JSON
      var oPayload = {
        product: oInfo.product,
        batch: oContext.getProperty("batchNumber"),
        dosageForm: oInfo.dosageForm || "",
        mfgDate: oInfo.mfgDate || "",
        expDate: oInfo.expDate || "",
        quantity: oInfo.quantity ? Number(oInfo.quantity) : 0,
        unit: oInfo.unit || "pcs"
      };
      if (oInfo.storageConditions) {
        oPayload.storageConditions = oInfo.storageConditions;
      }

      // Update both originPayload and product on the entity
      oContext.setProperty("originPayload", JSON.stringify(oPayload));
      oContext.setProperty("product", oInfo.product);

      var oModel = this.getView().getModel();
      oModel.submitBatch(oModel.getUpdateGroupId()).then(function () {
        MessageToast.show("Batch info saved");
      }).catch(function (err) {
        MessageBox.error("Failed to save: " + (err.message || err));
      });
    },

    // --- Confirm Receipt ---

    onConfirmReceipt: function () {
      var oContext = this.getView().getBindingContext();
      var sBatchId = oContext.getProperty("ID");

      MessageBox.confirm("Confirm receipt of batch '" + oContext.getProperty("batchNumber") + "'?", {
        title: "Confirm Receipt",
        onClose: function (sAction) {
          if (sAction === MessageBox.Action.OK) {
            var oModel = this.getView().getModel();
            var oActionBinding = oModel.bindContext("/ConfirmReceipt(...)");
            oActionBinding.setParameter("batchId", sBatchId);
            oActionBinding.execute().then(function () {
              MessageToast.show("Batch marked as delivered");
              this.getView().getElementBinding().refresh();
            }.bind(this)).catch(function (err) {
              MessageBox.error("Failed: " + (err.message || err));
            });
          }
        }.bind(this)
      });
    },

    // --- Signing Helper ---

    /**
     * Core pattern: call OData action -> sign with wallet -> submit
     */
    _signAndSubmit: function (sActionName, oPayload) {
      if (!CardanoWallet.isConnected()) {
        MessageBox.warning("Please connect your Cardano wallet first.");
        return Promise.reject(new Error("Wallet not connected"));
      }

      // Inject connected wallet address + VKH into every action payload
      oPayload.walletAddress = CardanoWallet.getAddress();
      oPayload.walletVkh = CardanoWallet.getVkh();

      var oModel = this.getView().getModel();
      var oActionBinding = oModel.bindContext("/" + sActionName + "(...)");

      // Set action parameters
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
          // Refresh the batch detail to show updated status
          this.getView().getElementBinding().refresh();
          return oSubmitResult;
        }.bind(this))
        .catch(function (err) {
          if (err.message && err.message.indexOf("User") >= 0) {
            MessageToast.show("Signing cancelled by user");
          } else {
            MessageBox.error("Transaction failed: " + (err.message || err));
          }
        });
    },

    // --- Action Handlers ---

    onMint: function () {
      var oContext = this.getView().getBindingContext();
      var sBatchId = oContext.getProperty("ID");

      MessageBox.confirm("Mint an NFT for batch '" + oContext.getProperty("batchNumber") + "' on Cardano?", {
        title: "Mint Batch NFT",
        onClose: function (sAction) {
          if (sAction === MessageBox.Action.OK) {
            this._signAndSubmit("MintBatchNft", { batchId: sBatchId });
          }
        }.bind(this)
      });
    },

    onTransfer: function () {
      var that = this;
      if (!this._pTransferDialog) {
        this._pTransferDialog = Fragment.load({
          id: this.getView().getId(),
          name: "trace.fragment.TransferDialog",
          controller: this
        }).then(function (oDialog) {
          that.getView().addDependent(oDialog);
          return oDialog;
        });
      }

      // Populate transfer context info
      var oContext = this.getView().getBindingContext();
      var oTransferModel = new JSONModel({
        batchNumber: oContext.getProperty("batchNumber"),
        product: oContext.getProperty("product"),
        currentHolder: oContext.getProperty("currentHolder/name") || "Unknown",
        recipientAddress: "",
        participants: []
      });
      this.getView().setModel(oTransferModel, "transfer");

      // Load active participants into JSONModel
      var oModel = this.getView().getModel();
      var oParticipantBinding = oModel.bindList("/Participants", null, null, [
        new Filter("isActive", FilterOperator.EQ, true)
      ]);
      oParticipantBinding.requestContexts(0, 100).then(function (aContexts) {
        var aParticipants = aContexts.map(function (ctx) {
          return {
            ID: ctx.getProperty("ID"),
            name: ctx.getProperty("name"),
            role: ctx.getProperty("role"),
            address: ctx.getProperty("address")
          };
        });
        oTransferModel.setProperty("/participants", aParticipants);
      });

      this._pTransferDialog.then(function (oDialog) {
        oDialog.open();
      });
    },

    onTransferParticipantChange: function (oEvent) {
      var oSelectedItem = oEvent.getParameter("selectedItem");
      if (!oSelectedItem) return;

      var oCtx = oSelectedItem.getBindingContext("transfer");
      if (oCtx) {
        var sAddress = oCtx.getProperty("address") || "";
        this.getView().getModel("transfer").setProperty("/recipientAddress", sAddress);
      }
    },

    onTransferConfirm: function () {
      var oContext = this.getView().getBindingContext();
      var sBatchId = oContext.getProperty("ID");
      var oSelect = this.byId("transferParticipant");
      var sToParticipantId = oSelect.getSelectedKey();

      if (!sToParticipantId) {
        MessageBox.warning("Please select a target participant.");
        return;
      }

      // Get optional notes and reason
      var sViewId = this.getView().getId();
      var oReason = sap.ui.getCore().byId(sViewId + "--transferReason");
      var oNotes = sap.ui.getCore().byId(sViewId + "--transferNotes");

      var sReason = oReason ? oReason.getSelectedKey() : "";
      var sNotes = oNotes ? oNotes.getValue() : "";

      this._pTransferDialog.then(function (d) { d.close(); });

      this._signAndSubmit("TransferBatch", {
        batchId: sBatchId,
        toParticipantId: sToParticipantId,
        transferReason: sReason,
        transferNotes: sNotes
      });
    },

    onTransferCancel: function () {
      this._pTransferDialog.then(function (d) { d.close(); });
    },

    onAnchorDoc: function () {
      if (!this._pAnchorDialog) {
        this._pAnchorDialog = Fragment.load({
          id: this.getView().getId(),
          name: "trace.fragment.AnchorDialog",
          controller: this
        }).then(function (oDialog) {
          this.getView().addDependent(oDialog);
          return oDialog;
        }.bind(this));
      }
      this._pAnchorDialog.then(function (oDialog) {
        sap.ui.getCore().byId(this.getView().getId() + "--anchorMode").setSelectedKey("document");
        this.onAnchorModeChange({ getSource: function () { return { getSelectedKey: function () { return "document"; } }; } });
        oDialog.open();
      }.bind(this));
    },

    onAnchorColdChain: function () {
      if (!this._pAnchorDialog) {
        this._pAnchorDialog = Fragment.load({
          id: this.getView().getId(),
          name: "trace.fragment.AnchorDialog",
          controller: this
        }).then(function (oDialog) {
          this.getView().addDependent(oDialog);
          return oDialog;
        }.bind(this));
      }
      this._pAnchorDialog.then(function (oDialog) {
        sap.ui.getCore().byId(this.getView().getId() + "--anchorMode").setSelectedKey("coldchain");
        this.onAnchorModeChange({ getSource: function () { return { getSelectedKey: function () { return "coldchain"; } }; } });
        oDialog.open();
      }.bind(this));
    },

    onAnchorModeChange: function (oEvent) {
      var sKey = oEvent.getParameter("key") || oEvent.getSource().getSelectedKey();
      var sViewId = this.getView().getId();
      var bColdChain = sKey === "coldchain";

      // Toggle document fields
      ["anchorDocTypeLabel", "anchorDocType", "anchorVisLabel", "anchorVisibility"].forEach(function (sId) {
        var oCtrl = sap.ui.getCore().byId(sViewId + "--" + sId);
        if (oCtrl) oCtrl.setVisible(!bColdChain);
      });
      // Toggle cold chain fields
      ["anchorMinTempLabel", "anchorMinTemp", "anchorMaxTempLabel", "anchorMaxTemp", "anchorInRangeLabel", "anchorInRange"].forEach(function (sId) {
        var oCtrl = sap.ui.getCore().byId(sViewId + "--" + sId);
        if (oCtrl) oCtrl.setVisible(bColdChain);
      });
    },

    onAnchorConfirm: function () {
      var sViewId = this.getView().getId();
      var oContext = this.getView().getBindingContext();
      var sBatchId = oContext.getProperty("ID");
      var sMode = sap.ui.getCore().byId(sViewId + "--anchorMode").getSelectedKey();
      var sHash = sap.ui.getCore().byId(sViewId + "--anchorHash").getValue();

      if (!sHash) {
        MessageBox.warning("Please enter the document hash.");
        return;
      }

      this._pAnchorDialog.then(function (d) { d.close(); });

      if (sMode === "coldchain") {
        var sMinTemp = sap.ui.getCore().byId(sViewId + "--anchorMinTemp").getValue();
        var sMaxTemp = sap.ui.getCore().byId(sViewId + "--anchorMaxTemp").getValue();
        var bInRange = sap.ui.getCore().byId(sViewId + "--anchorInRange").getState();

        this._signAndSubmit("AnchorColdChain", {
          batchId: sBatchId,
          telemetryHash: sHash,
          minTemp: parseFloat(sMinTemp) || 0,
          maxTemp: parseFloat(sMaxTemp) || 0,
          inRange: bInRange
        });
      } else {
        var sDocType = sap.ui.getCore().byId(sViewId + "--anchorDocType").getValue();
        var sVisibility = sap.ui.getCore().byId(sViewId + "--anchorVisibility").getSelectedKey();

        this._signAndSubmit("AnchorDocument", {
          batchId: sBatchId,
          documentHash: sHash,
          documentType: sDocType || "GENERIC",
          visibility: sVisibility || "PUBLIC"
        });
      }
    },

    onAnchorCancel: function () {
      this._pAnchorDialog.then(function (d) { d.close(); });
    },

    // --- Recall ---

    onRecall: function () {
      var that = this;
      if (!this._pRecallDialog) {
        this._pRecallDialog = Fragment.load({
          id: this.getView().getId(),
          name: "trace.fragment.RecallDialog",
          controller: this
        }).then(function (oDialog) {
          that.getView().addDependent(oDialog);
          return oDialog;
        });
      }
      this._pRecallDialog.then(function (oDialog) {
        // Clear previous reason
        var oReason = sap.ui.getCore().byId(that.getView().getId() + "--recallReason");
        if (oReason) oReason.setValue("");
        oDialog.open();
      });
    },

    onRecallConfirm: function () {
      var sViewId = this.getView().getId();
      var oContext = this.getView().getBindingContext();
      var sBatchId = oContext.getProperty("ID");
      var oReasonCtrl = sap.ui.getCore().byId(sViewId + "--recallReason");
      var sReason = oReasonCtrl ? oReasonCtrl.getValue() : "";

      if (!sReason) {
        MessageBox.error("Recall reason is required.");
        return;
      }

      this._pRecallDialog.then(function (d) { d.close(); });
      this._signAndSubmit("RecallBatch", { batchId: sBatchId, reason: sReason });
    },

    onRecallCancel: function () {
      this._pRecallDialog.then(function (d) { d.close(); });
    },

    onRetry: function (oEvent) {
      var sProofEventId = oEvent.getSource().getBindingContext().getProperty("ID");

      MessageBox.confirm("Retry this failed transaction?", {
        onClose: function (sAction) {
          if (sAction === MessageBox.Action.OK) {
            this._signAndSubmit("RetryFailedTransaction", { proofEventId: sProofEventId });
          }
        }.bind(this)
      });
    }
  });
});
