sap.ui.define([
  "sap/ui/core/UIComponent",
  "trace/model/models"
], function (UIComponent, models) {
  "use strict";

  return UIComponent.extend("trace.Component", {
    metadata: { manifest: "json" },

    init: function () {
      UIComponent.prototype.init.apply(this, arguments);
      this.getRouter().initialize();
    }
  });
});
