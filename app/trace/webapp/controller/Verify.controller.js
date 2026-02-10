sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/m/MessageBox",
  "sap/m/MessageToast",
  "sap/m/StandardListItem",
  "sap/m/ColumnListItem",
  "sap/m/Text",
  "sap/m/Link",
  "sap/m/ObjectStatus"
], function (Controller, MessageBox, MessageToast, StandardListItem, ColumnListItem, Text, Link, ObjectStatus) {
  "use strict";

  return Controller.extend("trace.controller.Verify", {

    onVerify: function () {
      var sInput = this.byId("verifyInput").getValue().trim();
      if (!sInput) {
        MessageToast.show("Please enter a batch ID or fingerprint");
        return;
      }

      var oModel = this.getView().getModel();
      var oFunctionBinding = oModel.bindContext("/VerifyBatch(...)");
      oFunctionBinding.setParameter("batchIdOrFingerprint", sInput);

      MessageToast.show("Verifying...");

      oFunctionBinding.execute()
        .then(function () {
          var oResult = oFunctionBinding.getBoundContext().getObject();
          this._displayResult(oResult);
        }.bind(this))
        .catch(function (err) {
          MessageBox.error("Verification failed: " + (err.message || err));
        });
    },

    _displayResult: function (oResult) {
      // Show results panel, hide empty state
      this.byId("verifyResults").setVisible(true);
      this.byId("emptyState").setVisible(false);

      // Summary
      var bValid = oResult.isValid;
      var bOnChain = oResult.onChainMatch;

      this.byId("validityStatus")
        .setText(bValid ? "Valid" : "Invalid")
        .setState(bValid ? "Success" : "Error");

      this.byId("onChainStatus")
        .setText(bOnChain ? "On-Chain Verified" : "On-Chain Mismatch")
        .setState(bOnChain ? "Success" : "Warning");

      this.byId("verifyFingerprint").setText(oResult.fingerprint || "-");
      this.byId("verifyHolder").setText(oResult.currentHolder || "-");
      this.byId("verifyStep").setText(String(oResult.step || 0));

      // Steps timeline
      var oTimeline = this.byId("stepsTimeline");
      oTimeline.destroyItems();

      (oResult.steps || []).forEach(function (oStep) {
        var sStateIcon = "";
        var sInfoState = "None";
        switch (oStep.onChainStatus) {
          case "verified":          sStateIcon = "sap-icon://accept"; sInfoState = "Success"; break;
          case "not_found":         sStateIcon = "sap-icon://alert";  sInfoState = "Error"; break;
          case "failed":            sStateIcon = "sap-icon://error";  sInfoState = "Error"; break;
          case "pending":           sStateIcon = "sap-icon://pending"; sInfoState = "Warning"; break;
          case "awaiting_signature": sStateIcon = "sap-icon://edit";   sInfoState = "None"; break;
          default:                  sStateIcon = "sap-icon://question-mark"; break;
        }

        var sDesc = "Holder: " + (oStep.holder ? oStep.holder.substring(0, 16) + "..." : "-");
        if (oStep.txHash) {
          sDesc += " | Tx: " + oStep.txHash.substring(0, 16) + "...";
        }

        oTimeline.addItem(new StandardListItem({
          title: "Step " + oStep.step + " — " + oStep.eventType,
          description: sDesc,
          icon: sStateIcon,
          info: oStep.onChainStatus,
          infoState: sInfoState,
          type: oStep.txHash ? "Navigation" : "Inactive",
          press: oStep.txHash ? function () {
            window.open("https://preview.cardanoscan.io/transaction/" + oStep.txHash, "_blank");
          } : undefined
        }));
      });

      // Document anchors
      var oDocsTable = this.byId("verifyDocsTable");
      oDocsTable.destroyItems();

      (oResult.documentAnchors || []).forEach(function (oDoc) {
        oDocsTable.addItem(new ColumnListItem({
          cells: [
            new Text({ text: oDoc.documentType }),
            new Text({ text: oDoc.documentHash ? oDoc.documentHash.substring(0, 16) + "..." : "-" }),
            new Text({ text: oDoc.visibility }),
            new ObjectStatus({
              text: oDoc.status,
              state: oDoc.status === "CONFIRMED" ? "Success" : oDoc.status === "FAILED" ? "Error" : "None"
            }),
            new Link({
              text: oDoc.txHash ? oDoc.txHash.substring(0, 16) + "..." : "-",
              href: oDoc.txHash ? "https://preview.cardanoscan.io/transaction/" + oDoc.txHash : "",
              target: "_blank",
              enabled: !!oDoc.txHash
            })
          ]
        }));
      });
    }
  });
});
