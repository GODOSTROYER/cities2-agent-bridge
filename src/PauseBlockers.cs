using System;
using System.Reflection;
using Game.Prefabs;
using Game.Simulation;
using Game.Tutorials;
using Game.UI.InGame;
using Newtonsoft.Json.Linq;
using Unity.Entities;

namespace CitiesIIAgentBridge
{
    // Explains why the simulation is held paused by the game itself and resolves the one
    // case agents can safely handle: an active tutorial phase card. TimeUISystem forces
    // speed 0 every frame while the window lacks focus or any UI panel observes its
    // "simulation paused barrier" binding; the barrier observers live in the UI layer, so
    // they are reported together with the active tutorial phase rather than by panel name.
    public sealed partial class Mod
    {
        private const BindingFlags AnyInstanceMember = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly;

        private static object ReadMember(object target, string name)
        {
            for (var type = target.GetType(); type != null; type = type.BaseType)
            {
                var property = type.GetProperty(name, AnyInstanceMember);
                if (property != null) return property.GetValue(target);
                var field = type.GetField(name, AnyInstanceMember);
                if (field != null) return field.GetValue(target);
            }
            throw new MissingMemberException(target.GetType().Name, name);
        }

        private static JToken PrefabName(World world, Entity entity)
        {
            if (entity == Entity.Null) return JValue.CreateNull();
            return world.GetExistingSystemManaged<PrefabSystem>().TryGetPrefab<PrefabBase>(entity, out var prefab) && prefab != null
                ? (JToken)prefab.name : "entity " + entity.Index + ":" + entity.Version;
        }

        private JObject PauseState()
        {
            var world = RequireCity();
            var simulation = world.GetExistingSystemManaged<SimulationSystem>();
            var time = world.GetExistingSystemManaged<TimeUISystem>();
            var tutorials = world.GetExistingSystemManaged<TutorialSystem>();
            var result = new JObject { ["selectedSpeed"] = simulation.selectedSpeed, ["controlEnabled"] = settings.AllowControl };
            var errors = new JArray();
            bool? focus = null; int observers = -1; JToken phase = JValue.CreateNull();
            try { focus = (bool)ReadMember(time, "m_HasFocus"); result["hasFocus"] = focus; }
            catch (Exception e) { errors.Add("hasFocus: " + e.GetBaseException().Message); }
            try { observers = (int)ReadMember(ReadMember(time, "m_SimulationPausedBarrierBinding"), "observerCount"); result["pausedBarrierObservers"] = observers; }
            catch (Exception e) { errors.Add("pausedBarrier: " + e.GetBaseException().Message); }
            try
            {
                phase = PrefabName(world, (Entity)ReadMember(tutorials, "activeTutorialPhase"));
                result["tutorial"] = new JObject
                {
                    ["enabled"] = (bool)ReadMember(tutorials, "tutorialEnabled"),
                    ["mode"] = ReadMember(tutorials, "mode")?.ToString(),
                    ["activeTutorial"] = PrefabName(world, (Entity)ReadMember(tutorials, "activeTutorial")),
                    ["activeTutorialPhase"] = phase
                };
            }
            catch (Exception e) { errors.Add("tutorial: " + e.GetBaseException().Message); }
            string blocker =
                observers > 0 && phase.Type != JTokenType.Null ? "tutorial_phase" :
                observers > 0 ? "unknown_ui_panel" :
                focus == false ? "window_not_focused" :
                simulation.selectedSpeed == 0 ? "paused_by_player_or_bridge" : "none";
            result["likelyBlocker"] = blocker;
            result["resolvableByBridge"] = blocker == "tutorial_phase";
            if (errors.Count > 0) result["errors"] = errors;
            return result;
        }

        // Completes only the active tutorial phase, exactly as the card's check button does.
        // Requires the caller to name the phase it saw, so a changed UI is never acted on.
        private JObject ResolvePauseBlocker(JObject args)
        {
            RequireControl();
            var world = RequireCity();
            string action = (string)args["action"];
            if (action == "dismiss_milestone") return DismissMilestone(world, args);
            if (action == "complete_tutorial_intro")
            {
                // Same as finishing the "How to build a city" intro: releases held milestones.
                var tutorials = world.GetExistingSystemManaged<TutorialSystem>();
                if (!(bool)ReadMember(tutorials, "tutorialIntroUnfinished")) throw new InvalidOperationException("tutorial_intro_already_complete");
                var tutorialsUi = world.GetExistingSystemManaged<TutorialsUISystem>();
                var intro = typeof(TutorialsUISystem).GetMethod("CompleteIntro", AnyInstanceMember, null, new[] { typeof(bool) }, null)
                    ?? throw new MissingMethodException("TutorialsUISystem", "CompleteIntro");
                intro.Invoke(tutorialsUi, new object[] { (bool)ReadMember(tutorials, "tutorialEnabled") });
                return new JObject { ["action"] = action, ["introUnfinishedAfter"] = (bool)ReadMember(tutorials, "tutorialIntroUnfinished") };
            }
            if (action != "complete_tutorial_phase") throw new ArgumentException("unsupported_action: complete_tutorial_phase, dismiss_milestone or complete_tutorial_intro");
            var before = PauseState();
            var phase = before["tutorial"]?["activeTutorialPhase"];
            if (phase == null || phase.Type == JTokenType.Null) throw new InvalidOperationException("no_active_tutorial_phase");
            string expected = (string)args["expectedPhase"];
            if (expected == null) throw new ArgumentException("expectedPhase_required: pass tutorial.activeTutorialPhase from get_pause_state");
            if (expected != (string)phase) throw new InvalidOperationException("tutorial_phase_changed: now " + phase);
            var ui = world.GetExistingSystemManaged<TutorialsUISystem>();
            var complete = typeof(TutorialsUISystem).GetMethod("CompleteActiveTutorialPhase", AnyInstanceMember, null, Type.EmptyTypes, null)
                ?? throw new MissingMethodException("TutorialsUISystem", "CompleteActiveTutorialPhase");
            complete.Invoke(ui, null);
            return new JObject
            {
                ["action"] = action, ["completedPhase"] = phase, ["before"] = before, ["after"] = PauseState(),
                ["note"] = "The UI releases its pause barrier on later frames; poll get_pause_state before resuming."
            };
        }
    }
}
