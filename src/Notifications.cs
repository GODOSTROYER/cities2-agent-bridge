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
        private static bool IsProblemIcon(string type) => type != null && type.IndexOf("Leveling", StringComparison.OrdinalIgnoreCase) < 0;

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

        // notifications {type?, top?}: counts by icon type and the items (position, owner) of the
        // types matching `type` (substring, case-insensitive; all problem types when omitted).
        private JObject Notifications(JObject args)
        {
            var w = RequireCity(); var em = w.EntityManager; var ps = w.GetExistingSystemManaged<PrefabSystem>();
            string filter = (string)args["type"]; int top = Math.Max(1, Math.Min(100, (int?)args["top"] ?? 20));
            var owned = OwnedTiles(em);
            var icons = ReadIcons(w).Where(i => owned.Contains(i.X, i.Z)).ToList(); var items = new JArray();
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
                ["total"] = icons.Count, ["items"] = items, ["citySession"] = citySession
            };
        }

        // Snapshot part: counts of the most frequent problem icons, the traffic-jam points, and a
        // "notification" event whenever a type appears or its count grows.
        private void SnapshotIcons(World w, JObject snapshotOut, uint frame, bool emit)
        {
            var ownedLand = OwnedTiles(w.EntityManager);
            var icons = ReadIcons(w).Where(i => ownedLand.Contains(i.X, i.Z)).ToList(); var counts = icons.GroupBy(i => i.Type).ToDictionary(g => g.Key, g => g.Count());
            snapshotOut["icons"] = new JObject(counts.OrderByDescending(p => p.Value).Take(6).Select(p => new JProperty(p.Key, p.Value)));
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
