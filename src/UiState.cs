using System;
using System.Linq;
using System.Reflection;
using Game.Prefabs;
using Game.SceneFlow;
using Game.Tools;
using Game.Triggers;
using Game.UI.InGame;
using Newtonsoft.Json.Linq;
using Unity.Collections;
using Unity.Entities;

namespace CitiesIIAgentBridge
{
    // One compact snapshot of what the player would see: screen/menu, open panel, tutorial
    // card, milestone popup, error dialog, active tool/infoview, newest chirps, and the most
    // likely reason the simulation is held paused. Every probe is isolated so a game update
    // that renames one member yields an entry in "errors" instead of failing the command.
    public sealed partial class Mod
    {
        private static void Probe(JArray errors, string name, Action probe)
        {
            try { probe(); }
            catch (Exception e) { errors.Add(name + ": " + e.GetBaseException().Message); }
        }

        private JObject UiState(JObject args)
        {
            var world = RequireCity();
            var result = PauseState();
            var errors = result["errors"] as JArray ?? new JArray();
            int observers = (int?)result["pausedBarrierObservers"] ?? -1;
            bool menu = false; string screen = null; JToken milestone = JValue.CreateNull(); bool errorDialog = false;

            Probe(errors, "screen", () =>
            {
                var system = world.GetExistingSystemManaged<GameScreenUISystem>();
                screen = ReadMember(system, "activeScreen")?.ToString();
                menu = (bool)ReadMember(system, "isMenuActive");
                result["screen"] = screen; result["menuActive"] = menu;
            });
            Probe(errors, "panel", () =>
            {
                var panel = ReadMember(world.GetExistingSystemManaged<GamePanelUISystem>(), "activePanel");
                result["activePanel"] = panel == null ? JValue.CreateNull() : (JToken)panel.GetType().Name;
                if (panel != null) result["panelBlocking"] = (bool)ReadMember(panel, "blocking");
            });
            Probe(errors, "milestone", () =>
            {
                var milestones = world.GetExistingSystemManaged<MilestoneUISystem>();
                var pendingEntity = (Entity)ReadMember(ReadMember(milestones, "m_UnlockedMilestoneBinding"), "value");
                milestone = PrefabName(world, pendingEntity);
                var info = new JObject { ["pending"] = milestone };
                Probe(errors, "milestoneXp", () =>
                {
                    info["achieved"] = JToken.FromObject(CallPrivate(milestones, "GetAchievedMilestone"));
                    info["xp"] = JToken.FromObject(CallPrivate(milestones, "GetTotalXP"));
                    info["nextXp"] = JToken.FromObject(CallPrivate(milestones, "GetNextMilestoneXP"));
                    info["xpToNext"] = (int)info["nextXp"] - (int)info["xp"];
                });
                if (pendingEntity != Entity.Null && world.GetExistingSystemManaged<PrefabSystem>().TryGetPrefab<MilestonePrefab>(pendingEntity, out var reached))
                {
                    info["pendingIndex"] = reached.m_Index; info["pendingReward"] = reached.m_Reward;
                    info["pendingText"] = LocalizedFor(reached.name, 3);
                }
                result["milestone"] = info;
            });
            Probe(errors, "tutorialText", () =>
            {
                var tutorials = world.GetExistingSystemManaged<Game.Tutorials.TutorialSystem>();
                var phaseEntity = (Entity)ReadMember(tutorials, "activeTutorialPhase");
                if (phaseEntity == Entity.Null || !(result["tutorial"] is JObject tutorial)) return;
                if (world.GetExistingSystemManaged<PrefabSystem>().TryGetPrefab<PrefabBase>(phaseEntity, out var phasePrefab) && phasePrefab != null)
                {
                    tutorial["phaseKind"] = phasePrefab.GetType().Name.Replace("Tutorial", "").Replace("Prefab", "");
                    tutorial["phaseText"] = LocalizedFor(phasePrefab.name, 3);
                }
            });
            Probe(errors, "errorDialog", () =>
            {
                var bindings = ReadMember(ReadMember(GameManager.instance, "userInterface"), "appBindings");
                var current = ReadMember(ReadMember(bindings, "m_ErrorDialogManager"), "currentError");
                if (current == null) return;
                errorDialog = true;
                result["dialogs"] = new JArray(new JObject
                {
                    ["type"] = "error",
                    ["severity"] = ReadMember(current, "severity")?.ToString(),
                    ["title"] = ReadMember(current, "localizedTitle")?.ToString(),
                    ["message"] = ReadMember(current, "localizedMessage")?.ToString()
                });
            });
            Probe(errors, "tool", () =>
            {
                var tools = world.GetExistingSystemManaged<ToolSystem>();
                result["activeTool"] = tools.activeTool?.GetType().Name;
                result["infoview"] = tools.activeInfoview != null ? (JToken)tools.activeInfoview.name : JValue.CreateNull();
            });
            int chirpCount = Math.Max(0, Math.Min(10, (int?)args?["chirps"] ?? 3));
            if (chirpCount > 0) Probe(errors, "chirps", () => result["chirps"] = LatestChirps(world, chirpCount));

            string phase = (string)result["tutorial"]?["activeTutorialPhase"];
            bool hasMilestone = milestone.Type != JTokenType.Null;
            string blocker =
                errorDialog ? "error_dialog" :
                menu || (screen != null && screen != "Main" && screen != "FreeCamera") ? "menu_screen" :
                observers > 0 && hasMilestone ? "milestone_popup" :
                observers > 0 && phase != null ? "tutorial_phase" :
                observers > 0 ? "unknown_ui_panel" :
                (bool?)result["hasFocus"] == false ? "window_not_focused" :
                (double)result["selectedSpeed"] == 0 ? "paused_by_player_or_bridge" : "none";
            result["likelyBlocker"] = blocker;
            result["resolvableByBridge"] = blocker == "tutorial_phase" || blocker == "milestone_popup";
            if (errors.Count > 0) result["errors"] = errors;
            return result;
        }

        private static object CallPrivate(object target, string method) =>
            (target.GetType().GetMethod(method, AnyInstanceMember, null, Type.EmptyTypes, null)
                ?? throw new MissingMethodException(target.GetType().Name, method)).Invoke(target, null);

        // Player-visible text for a prefab: every active-locale entry whose ID mentions
        // "[<prefab name>]" (CS2's convention, e.g. Tutorials.TITLE[...]/DESCRIPTION[...]).
        // Trimmed so a card costs an agent a few hundred characters at most.
        private static JObject LocalizedFor(string prefabName, int max)
        {
            var output = new JObject();
            var dictionary = ReadMember(GameManager.instance.localizationManager, "activeDictionary");
            if (dictionary == null || string.IsNullOrEmpty(prefabName)) return output;
            string needle = "[" + prefabName + "]";
            var ids = ReadMember(dictionary, "entryIDs") as System.Collections.Generic.IEnumerable<string>;
            var tryGet = dictionary.GetType().GetMethod("TryGetValue", new[] { typeof(string), typeof(string).MakeByRefType() });
            if (ids == null || tryGet == null) return output;
            foreach (var id in ids.Where(i => i.Contains(needle)).OrderBy(i => i.Contains("TITLE") ? 0 : 1).Take(max))
            {
                var call = new object[] { id, null };
                if (!(bool)tryGet.Invoke(dictionary, call)) continue;
                string text = System.Text.RegularExpressions.Regex.Replace((string)call[1] ?? "", "<[^>]+>|\\s+", " ").Trim();
                output[id] = text.Length > 300 ? text.Substring(0, 300) + "…" : text;
            }
            return output;
        }

        private static JArray LatestChirps(World world, int count)
        {
            var manager = world.EntityManager;
            var chirper = world.GetExistingSystemManaged<ChirperUISystem>();
            var messageId = typeof(ChirperUISystem).GetMethod("GetMessageID", AnyInstanceMember, null, new[] { typeof(Entity) }, null);
            var dictionary = ReadMember(GameManager.instance.localizationManager, "activeDictionary");
            var tryGet = dictionary?.GetType().GetMethod("TryGetValue", new[] { typeof(string), typeof(string).MakeByRefType() });
            using (var query = manager.CreateEntityQuery(ComponentType.ReadOnly<Game.Triggers.Chirp>()))
            using (var entities = query.ToEntityArray(Allocator.Temp))
            {
                var newest = entities.ToArray().Select(e => (e, chirp: manager.GetComponentData<Game.Triggers.Chirp>(e)))
                    .OrderByDescending(x => x.chirp.m_CreationFrame).Take(count);
                var output = new JArray();
                foreach (var (entity, chirp) in newest)
                {
                    string id = messageId?.Invoke(chirper, new object[] { entity }) as string;
                    string text = id;
                    if (id != null && tryGet != null)
                    {
                        var call = new object[] { id, null };
                        if ((bool)tryGet.Invoke(dictionary, call)) text = (string)call[1];
                    }
                    output.Add(new JObject { ["text"] = text, ["likes"] = chirp.m_Likes, ["frame"] = chirp.m_CreationFrame });
                }
                return output;
            }
        }

        // Clears the "milestone reached" popup exactly as closing it does. The caller must
        // name the milestone it saw so a changed UI is never acted on.
        private JObject DismissMilestone(World world, JObject args)
        {
            var before = UiState(new JObject { ["chirps"] = 0 });
            var pending = before["milestone"]?["pending"];
            if (pending == null || pending.Type == JTokenType.Null) throw new InvalidOperationException("no_pending_milestone_popup");
            string expected = (string)args["expectedMilestone"];
            if (expected == null) throw new ArgumentException("expectedMilestone_required: pass milestone.pending from get_ui_state");
            if (expected != (string)pending) throw new InvalidOperationException("milestone_changed: now " + pending);
            var clear = typeof(MilestoneUISystem).GetMethod("ClearUnlockedMilestone", AnyInstanceMember, null, Type.EmptyTypes, null)
                ?? throw new MissingMethodException("MilestoneUISystem", "ClearUnlockedMilestone");
            clear.Invoke(world.GetExistingSystemManaged<MilestoneUISystem>(), null);
            return new JObject { ["action"] = "dismiss_milestone", ["dismissed"] = pending, ["after"] = UiState(new JObject { ["chirps"] = 0 }),
                ["note"] = "The UI releases its pause barrier on later frames; poll get_ui_state before resuming." };
        }
    }
}
