import { APIResource } from "../../../core/resource.mjs";
import * as EffectiveAPI from "./effective.mjs";
import { Effective } from "./effective.mjs";
import * as IncreaseRequestsAPI from "./increase-requests.mjs";
import { IncreaseRequests, } from "./increase-requests.mjs";
export var SpendLimits = /* @__PURE__ */ (() => {
    class SpendLimits extends APIResource {
        constructor() {
            super(...arguments);
            this.effective = new EffectiveAPI.Effective(this._client);
            this.increaseRequests = new IncreaseRequestsAPI.IncreaseRequests(this._client);
        }
    }
    SpendLimits.Effective = Effective;
    SpendLimits.IncreaseRequests = IncreaseRequests;
    return SpendLimits;
})();
