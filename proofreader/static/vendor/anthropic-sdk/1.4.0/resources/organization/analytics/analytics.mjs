import { APIResource } from "../../../core/resource.mjs";
import * as ArtifactsAPI from "./artifacts.mjs";
import { Artifacts } from "./artifacts.mjs";
import * as ConnectorsAPI from "./connectors.mjs";
import { Connectors } from "./connectors.mjs";
import * as PluginsAPI from "./plugins.mjs";
import { Plugins } from "./plugins.mjs";
import * as SkillsAPI from "./skills.mjs";
import { Skills } from "./skills.mjs";
import * as SummariesAPI from "./summaries.mjs";
import { Summaries } from "./summaries.mjs";
import * as UsersAPI from "./users.mjs";
import { Users } from "./users.mjs";
import * as AppsAPI from "./apps/apps.mjs";
import { Apps } from "./apps/apps.mjs";
export var Analytics = /* @__PURE__ */ (() => {
    class Analytics extends APIResource {
        constructor() {
            super(...arguments);
            this.summaries = new SummariesAPI.Summaries(this._client);
            this.users = new UsersAPI.Users(this._client);
            this.apps = new AppsAPI.Apps(this._client);
            this.connectors = new ConnectorsAPI.Connectors(this._client);
            this.plugins = new PluginsAPI.Plugins(this._client);
            this.skills = new SkillsAPI.Skills(this._client);
            this.artifacts = new ArtifactsAPI.Artifacts(this._client);
        }
    }
    Analytics.Summaries = Summaries;
    Analytics.Users = Users;
    Analytics.Apps = Apps;
    Analytics.Connectors = Connectors;
    Analytics.Plugins = Plugins;
    Analytics.Skills = Skills;
    Analytics.Artifacts = Artifacts;
    return Analytics;
})();
