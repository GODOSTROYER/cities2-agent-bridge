using System;
using System.IO;
using Newtonsoft.Json.Linq;

namespace CitiesIIAgentBridge
{
    // While bridge controls are on, the game must never idle on a tutorial card, milestone or
    // signature popup, or an intro-held milestone (FAILURES #24, #37). Resolved here on the main
    // thread from a fresh UI read, so the expected phase/popup can never race the action.
    public sealed partial class Mod
    {
        private DateTime nextAutoResolve;
        private int autoResolveFailures;

        private void AutoResolvePopups(uint frame)
        {
            if (!settings.AllowControl || File.Exists(Path.Combine(mailbox.Root, "STOP")) || DateTime.UtcNow < nextAutoResolve) return;
            string blocker = (string)snapshot?["ui"]?["blocker"];
            bool introHeld = (string)snapshot?["milestone"]?["blockedBy"] == "tutorial_intro";
            if (blocker != "tutorial_phase" && blocker != "milestone_popup" && blocker != "signature_popup" && !introHeld) return;
            nextAutoResolve = DateTime.UtcNow.AddSeconds(autoResolveFailures > 3 ? 30 : 1.5);
            var live = UiState(new JObject { ["chirps"] = 0 });
            string now = (string)live["likelyBlocker"]; JObject request;
            if (now == "milestone_popup") request = new JObject { ["action"] = "dismiss_milestone", ["expectedMilestone"] = live["milestone"]?["pending"] };
            else if (now == "signature_popup") request = new JObject { ["action"] = "dismiss_signature", ["expectedSignature"] = live["signatures"]?["pending"]?[0]?["name"] };
            else if (now == "tutorial_phase") request = new JObject { ["action"] = "complete_tutorial_phase", ["expectedPhase"] = live["tutorial"]?["activeTutorialPhase"] };
            else if ((string)live["milestone"]?["blockedBy"] == "tutorial_intro") request = new JObject { ["action"] = "complete_tutorial_intro" };
            else return;
            string name = (string)(request["expectedMilestone"] ?? request["expectedSignature"] ?? request["expectedPhase"]);
            try
            {
                ResolvePauseBlocker(request);
                autoResolveFailures = 0;
                string need = request["expectedPhase"] != null ? ServiceSignals.ServiceForText(name) : null;
                if (need != null) { if (tutorialNeeds == null) tutorialNeeds = new System.Collections.Generic.HashSet<string>(); tutorialNeeds.Add(need); }
                EmitEvent("auto_resolved", frame, new JObject { ["action"] = request["action"], ["name"] = name });
                snapshotUtc = DateTime.MinValue; // refresh on the next tick to catch a queued card
            }
            catch (Exception e)
            {
                if (++autoResolveFailures <= 3)
                    EmitEvent("auto_resolve_failed", frame, new JObject { ["action"] = request["action"], ["name"] = name, ["error"] = e.GetBaseException().Message });
            }
        }
    }
}
