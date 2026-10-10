using System;
using System.Collections.Generic;
using System.Linq;
using Game.Common;
using Game.Prefabs;
using Newtonsoft.Json.Linq;
using Unity.Collections;
using Unity.Entities;

namespace CitiesIIAgentBridge
{
    // Service-need signals for the snapshot (FAILURES #38): citizens' dead/sick state, the
    // notification icons the player sees, chirp complaints and tutorial cards that ask for a
    // service. The play loop must act on these before growth.
    public sealed partial class Mod
    {
        private HashSet<string> tutorialNeeds;
        private Dictionary<string, int> needIconsBefore, needIconStreak;
        


        private JObject ServiceNeeds(World w, JArray chirps, string tutorialPhase, JObject happiness)
        {
            var em = w.EntityManager; var needs = new Dictionary<string, JObject>();
            JObject Need(string k) { if (!needs.TryGetValue(k, out var n)) needs[k] = n = new JObject(); return n; }
            if (tutorialNeeds == null) tutorialNeeds = new HashSet<string>();
            string fromCard = ServiceSignals.ServiceForText(tutorialPhase); if (fromCard != null) tutorialNeeds.Add(fromCard);
            foreach (var k in tutorialNeeds) Need(k)["tutorial"] = true;

            int dead = 0, sick = 0, injured = 0;
            using (var q = em.CreateEntityQuery(new EntityQueryDesc { All = new[] { ComponentType.ReadOnly<Game.Citizens.HealthProblem>() }, None = new[] { ComponentType.ReadOnly<Deleted>() } }))
            using (var problems = q.ToComponentDataArray<Game.Citizens.HealthProblem>(Allocator.Temp))
                foreach (var p in problems)
                {
                    if ((p.m_Flags & Game.Citizens.HealthProblemFlags.Dead) != 0) dead++;
                    else if ((p.m_Flags & Game.Citizens.HealthProblemFlags.Sick) != 0) sick++;
                    else if ((p.m_Flags & Game.Citizens.HealthProblemFlags.Injured) != 0) injured++;
                }
            if (dead > 0) Need("deathcare")["dead"] = dead;
            if (sick + injured > 0) Need("health")["sick"] = sick + injured;

            // Notification icons by prefab name (what the player sees over buildings).
            var ps = w.GetExistingSystemManaged<PrefabSystem>(); var icons = new Dictionary<string, int>();
            using (var q = em.CreateEntityQuery(new EntityQueryDesc { All = new[] { ComponentType.ReadOnly<Game.Notifications.Icon>(), ComponentType.ReadOnly<PrefabRef>() }, None = new[] { ComponentType.ReadOnly<Deleted>() } }))
            using (var refs = q.ToComponentDataArray<PrefabRef>(Allocator.Temp))
                foreach (var r in refs) { string n = ps.GetPrefabName(r.m_Prefab) ?? "?"; icons[n] = icons.TryGetValue(n, out var c) ? c + 1 : 1; }
            foreach (var pair in icons)
            {
                string k = ServiceSignals.ServiceForText(pair.Key); if (k == null) continue;
                var n = Need(k); n["icons"] = ((int?)n["icons"] ?? 0) + pair.Value;
            }
            if (chirps != null)
                foreach (var c in chirps)
                {
                    string k = ServiceSignals.ServiceForText((string)c["text"]); if (k == null) continue;
                    var n = Need(k); n["chirps"] = ((int?)n["chirps"] ?? 0) + 1;
                }
            if (happiness != null)
                foreach (var f in happiness.Properties())
                {
                    string k = ServiceSignals.NeedForFactor(f.Name); double effect = (double)f.Value;
                    if (k == null || effect > -1) continue;
                    var n = Need(k); n["factor"] = Math.Min((double?)n["factor"] ?? 0, effect);
                }
            if (needIconsBefore == null) { needIconsBefore = new Dictionary<string, int>(); needIconStreak = new Dictionary<string, int>(); }
            var result = new JObject();
            foreach (var pair in needs.OrderBy(p => p.Key))
            {
                var n = pair.Value; int iconsNow = (int?)n["icons"] ?? 0;
                int before = needIconsBefore.TryGetValue(pair.Key, out var b) ? b : iconsNow;
                int streak = needIconStreak.TryGetValue(pair.Key, out var st) ? st : 0;
                streak = iconsNow > before ? streak + 1 : iconsNow < before ? 0 : streak;
                needIconStreak[pair.Key] = streak; needIconsBefore[pair.Key] = iconsNow;
                if (streak > 0) n["iconRise"] = streak;
                int score = ServiceSignals.NeedScore((int?)n["chirps"] ?? 0, (bool?)n["tutorial"] == true, streak, ((int?)n["dead"] ?? 0) + ((int?)n["sick"] ?? 0), iconsNow, (double?)n["factor"] ?? 0);
                n["score"] = score + "/" + ServiceSignals.Threshold; n["action"] = score >= ServiceSignals.Threshold ? "build" : "watch";
                if (n["factor"] != null) { string tag = ServiceSignals.FactorPriority((double)n["factor"]); if (tag != "normal") n["priority"] = tag; }
                result[pair.Key] = n;
            }
            return result;
        }
    }
}
