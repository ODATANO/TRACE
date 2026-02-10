sap.ui.define([
  "sap/ui/model/json/JSONModel"
], function (JSONModel) {
  "use strict";

  return {
    createWalletModel: function () {
      return new JSONModel({
        connected: false,
        name: "",
        icon: "",
        address: "",
        wallets: []
      });
    }
  };
});
