using System;
using System.Collections.Generic;
using System.Linq;
using Game.Common;
using Game.Prefabs;
using Game.Tools;
using Newtonsoft.Json.Linq;
using Unity.Collections;
using Unity.Entities;

namespace CitiesIIAgentBridge
{
    // The hexagon icons the player sees over buildings and roads (traffic bottleneck, burned
    // down, noise pollution, hearse, garbage, no power...). They are Game.Notifications.Icon
    // entities whose prefab names the problem and whose Owner is the building or road.
    public sealed partial class Mod
    {
        private Dictionary<string, int> iconCountsBefore;

        private struct IconRow { public string Type; public float X, Z; public Entity Owner; }

        // "Leveling Building" is the level-up marker, not a problem.
        // Markers the game also draws as icons (selection, level-up, mood, outside-connection
        // signs) are not problems and must not be counted or clustered.
        private static readonly HashSet<string> MarkerIcons = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "Selected", "Followed", "Happy Face", "Sad Face", "Building Level Up", "ValentineHeart", "Work Location", "Work Stop" };
        private static bool IsProblemIcon(string type) => type != null && type.IndexOf("Leveling", StringComparison.OrdinalIgnoreCase) < 0 && !MarkerIcons.Contains(type)
            && !(type.EndsWith("Outside Connection", StringComparison.OrdinalIgnoreCase) && !type.StartsWith("No ", StringComparison.OrdinalIgnoreCase));

        private static List<IconRow> ReadIcons(World w)
        {
            var em = w.EntityManager; var ps = w.GetExistingSystemManaged<PrefabSystem>(); var rows = new List<IconRow>();
            using (var q = em.CreateEntityQuery(new EntityQueryDesc
            {
                All = new[] { ComponentType.ReadOnly<Game.Notifications.Icon>(), ComponentType.ReadOnly<PrefabRef>() },
                None = new[] { ComponentType.ReadOnly<Deleted>(), ComponentType.ReadOnly<Temp>() }
            }))
            using (var es = q.ToEntityArray(Allocator.Temp))
                foreach (var e in es)
                {
                    string type = ps.GetPrefabName(em.GetComponentData<PrefabRef>(e).m_Prefab) ?? "?";
                    if (!IsProblemIcon(type)) continue;
                    var icon = em.GetComponentData<Game.Notifications.Icon>(e);
                    rows.Add(new IconRow { Type = type, X = icon.m_Location.x, Z = icon.m_Location.z, Owner = ResolveOwner(em, em.HasComponent<Owner>(e) ? em.GetComponentData<Owner>(e).m_Owner : Entity.Null) });
                }
            return rows;
        }

        // A traffic icon is owned by a lane, a lane by its road: walk up to the building, road or
        // junction the player would click on.
        private static Entity ResolveOwner(EntityManager em, Entity owner)
        {
            for (int hop = 0; hop < 6 && owner != Entity.Null && em.Exists(owner); hop++)
            {
                if (em.HasComponent<Game.Buildings.Building>(owner) || em.HasComponent<Game.Net.Edge>(owner) || em.HasComponent<Game.Net.Node>(owner)) return owner;
                if (!em.HasComponent<Owner>(owner)) return owner;
                owner = em.GetComponentData<Owner>(owner).m_Owner;
            }
            return owner;
        }

        private static string OwnerKind(EntityManager em, Entity owner)
        {
            if (owner == Entity.Null || !em.Exists(owner)) return "none";
            if (em.HasComponent<Game.Buildings.Building>(owner)) return "building";
            if (em.HasComponent<Game.Net.Edge>(owner)) return "road";
            if (em.HasComponent<Game.Net.Node>(owner)) return "junction";
            return "other";
        }

        // notifications {type?, top?, x0?, x1?, z0?, z1?}: counts by icon type and the items (position, owner) of the
        // (with x0..z1 the counts, clusters and items are those of that rectangle only: one district)
        // types matching `type` (substring, case-insensitive; all problem types when omitted).
        private JObject Notifications(JObject args)
        {
            var w = RequireCity(); var em = w.EntityManager; var ps = w.GetExistingSystemManaged<PrefabSystem>();
            string filter = (string)args["type"]; int top = Math.Max(1, Math.Min(400, (int?)args["top"] ?? 20));
            if ((bool?)args["catalog"] == true)
            {
                var names = new List<string>();
                using (var q = em.CreateEntityQuery(ComponentType.ReadOnly<PrefabData>(), ComponentType.ReadOnly<NotificationIconData>()))
                using (var es = q.ToEntityArray(Allocator.Temp))
                    foreach (var e in es) names.Add(ps.GetPrefabName(e) ?? "?");
                names.Sort(StringComparer.Ordinal);
                return new JObject { ["catalog"] = new JObject(names.Distinct().Select(n => new JProperty(n, IsProblemIcon(n) ? ServiceSignals.NeedForIcon(n) : "not_a_problem"))), ["count"] = names.Count, ["unmapped"] = new JArray(names.Distinct().Where(n => IsProblemIcon(n) && ServiceSignals.NeedForIcon(n) == "inspect")) };
            }
            var owned = OwnedTiles(em);
            var icons = ReadIcons(w).Where(i => owned.Contains(i.X, i.Z)).ToList(); var items = new JArray();
            if (args["x0"] != null && args["x1"] != null && args["z0"] != null && args["z1"] != null)
            {
                double ax = RequiredFloat(args, "x0"), bx = RequiredFloat(args, "x1"), az = RequiredFloat(args, "z0"), bz = RequiredFloat(args, "z1");
                icons = icons.Where(i => i.X >= Math.Min(ax, bx) && i.X <= Math.Max(ax, bx) && i.Z >= Math.Min(az, bz) && i.Z <= Math.Max(az, bz)).ToList();
            }
            foreach (var icon in icons.Where(i => filter == null || i.Type.IndexOf(filter, StringComparison.OrdinalIgnoreCase) >= 0).Take(top))
            {
                var row = new JObject { ["type"] = icon.Type, ["x"] = Math.Round(icon.X), ["z"] = Math.Round(icon.Z), ["ownerKind"] = OwnerKind(em, icon.Owner) };
                if (icon.Owner != Entity.Null && em.Exists(icon.Owner))
                {
                    row["owner"] = NativeBuild.Id(icon.Owner);
                    if (em.HasComponent<PrefabRef>(icon.Owner)) row["ownerPrefab"] = ps.GetPrefabName(em.GetComponentData<PrefabRef>(icon.Owner).m_Prefab);
                    if (em.HasComponent<Destroyed>(icon.Owner)) row["destroyed"] = true;
                    if (em.HasComponent<Game.Buildings.Abandoned>(icon.Owner)) row["abandoned"] = true;
                }
                items.Add(row);
            }
            return new JObject
            {
                ["counts"] = new JObject(icons.GroupBy(i => i.Type).OrderByDescending(g => g.Count()).Select(g => new JProperty(g.Key, g.Count()))),
                ["clusters"] = new JArray(IconClusters(icons, 16).Select(c => new JArray(c.type, c.n, c.x, c.z, c.need))),
                ["total"] = icons.Count, ["items"] = items, ["citySession"] = citySession
            };
        }

        private static List<(string type, int n, double x, double z, string need)> IconClusters(List<IconRow> icons, int top)
        {
            return icons.GroupBy(i => i.Type)
                .SelectMany(g => PointClusters.Densest(g.Select(i => ((double)i.X, (double)i.Z)), 300, 2).Select(c => (type: g.Key, n: c.n, x: Math.Round(c.x), z: Math.Round(c.z), need: ServiceSignals.NeedForIcon(g.Key))))
                .OrderByDescending(c => c.n).Take(top).ToList();
        }

        // Snapshot part: counts of the most frequent problem icons, the traffic-jam points, and a
        // "notification" event whenever a type appears or its count grows.
        private void SnapshotIcons(World w, JObject snapshotOut, uint frame, bool emit)
        {
            var ownedLand = OwnedTiles(w.EntityManager);
            var icons = ReadIcons(w).Where(i => ownedLand.Contains(i.X, i.Z)).ToList(); var counts = icons.GroupBy(i => i.Type).ToDictionary(g => g.Key, g => g.Count());
            snapshotOut["icons"] = new JObject(counts.OrderByDescending(p => p.Value).Take(6).Select(p => new JProperty(p.Key, p.Value)));
            // Rule E: where the icons are. Each row is [type, count, x, z, need]: the densest 300 m
            // cells per type, largest first, so "No Electricity x65 at (x,z)" is one line the
            // play loop can act on.
            snapshotOut["iconClusters"] = new JArray(IconClusters(icons, 8).Select(c => new JArray(c.type, c.n, c.x, c.z, c.need)));
            var broken = icons.Where(i => ServiceSignals.IsNetworkWarning(i.Type)).ToList();
            if (broken.Count > 0)
            {
                var needs = snapshotOut["needs"] as JObject; if (needs == null) snapshotOut["needs"] = needs = new JObject();
                needs["network"] = new JObject
                {
                    ["icons"] = broken.Count, ["at"] = new JArray(broken.Take(5).Select(i => new JArray(i.Type, Math.Round(i.X), Math.Round(i.Z)))),
                    ["score"] = (ServiceSignals.Threshold + broken.Count) + "/" + ServiceSignals.Threshold, ["action"] = "connect", ["priority"] = "very_high",
                    ["say"] = "join or remove the loose end at each position (build_line to the nearest network, or remove_road)"
                };
            }
            var jams = icons.Where(i => i.Type.IndexOf("Traffic", StringComparison.OrdinalIgnoreCase) >= 0).Take(3).Select(i => new JArray(Math.Round(i.X), Math.Round(i.Z)));
            if (jams.Any()) snapshotOut["jams"] = new JArray(jams);
            if (iconCountsBefore != null && emit)
                foreach (var pair in counts)
                {
                    iconCountsBefore.TryGetValue(pair.Key, out int before);
                    if (pair.Value <= before || !Throttle("icon_" + pair.Key, frame, 2048)) continue;
                    var first = icons.First(i => i.Type == pair.Key);
                    EmitEvent("notification", frame, new JObject { ["type"] = pair.Key, ["count"] = pair.Value, ["was"] = before, ["x"] = Math.Round(first.X), ["z"] = Math.Round(first.Z), ["need"] = ServiceSignals.ServiceForText(pair.Key) });
                }
            iconCountsBefore = counts;
        }
    }
}
