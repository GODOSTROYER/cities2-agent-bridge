using System;
using System.Collections.Generic;
using System.Linq;
using Game.City;
using Game.Prefabs;
using Newtonsoft.Json.Linq;
using Unity.Collections;
using Unity.Entities;

namespace CitiesIIAgentBridge
{
    // Development tree: milestones grant points, and many buildings (college, bus lines, wider
    // roads) stay locked until their node is bought with them. Without this the agent reads
    // "locked (milestone)" forever (FAILURES #69, #90).
    public sealed partial class Mod
    {
        private sealed class DevNode { public Entity Entity; public string Name, Service; public int Cost; public bool Bought, ServiceOpen, RequirementsMet; public List<string> Requires = new List<string>(); }

        private static List<DevNode> ReadDevNodes(World w)
        {
            var em = w.EntityManager; var ps = w.GetExistingSystemManaged<PrefabSystem>(); var rows = new List<DevNode>();
            using (var q = em.CreateEntityQuery(ComponentType.ReadOnly<PrefabData>(), ComponentType.ReadOnly<DevTreeNodeData>()))
            using (var es = q.ToEntityArray(Allocator.Temp))
                foreach (var e in es)
                {
                    var d = em.GetComponentData<DevTreeNodeData>(e);
                    var n = new DevNode { Entity = e, Name = ps.GetPrefabName(e) ?? "?", Cost = d.m_Cost, Bought = !IsPrefabLocked(em, e) };
                    n.Service = d.m_Service != Entity.Null && em.Exists(d.m_Service) ? ps.GetPrefabName(d.m_Service) : null;
                    n.ServiceOpen = d.m_Service == Entity.Null || !em.Exists(d.m_Service) || !IsPrefabLocked(em, d.m_Service);
                    n.RequirementsMet = true;
                    if (em.HasBuffer<DevTreeNodeRequirement>(e))
                        foreach (var r in em.GetBuffer<DevTreeNodeRequirement>(e, true))
                        {
                            if (r.m_Node == Entity.Null || !em.Exists(r.m_Node)) continue;
                            n.Requires.Add(ps.GetPrefabName(r.m_Node) ?? "?");
                            if (IsPrefabLocked(em, r.m_Node)) n.RequirementsMet = false;
                        }
                    rows.Add(n);
                }
            return rows;
        }

        // dev_tree {all?}: points and the nodes that can be bought now (all nodes with all:true).
        private JObject DevTree(JObject args)
        {
            var w = RequireCity(); var system = w.GetExistingSystemManaged<DevTreeSystem>();
            int points = system?.points ?? 0; bool all = (bool?)args["all"] == true; var nodes = ReadDevNodes(w);
            JObject Row(DevNode n) => new JObject { ["name"] = n.Name, ["service"] = n.Service, ["cost"] = n.Cost, ["bought"] = n.Bought, ["requires"] = new JArray(n.Requires), ["canBuy"] = DevTreeRules.CanBuy(n.Bought, n.ServiceOpen, n.RequirementsMet, n.Cost, points) == null, ["why"] = DevTreeRules.CanBuy(n.Bought, n.ServiceOpen, n.RequirementsMet, n.Cost, points) };
            var shown = nodes.Where(n => all || (!n.Bought && n.ServiceOpen && n.RequirementsMet)).OrderBy(n => n.Service).ThenBy(n => n.Cost);
            return new JObject { ["points"] = points, ["nodes"] = new JArray(shown.Select(Row)), ["total"] = nodes.Count, ["bought"] = nodes.Count(n => n.Bought), ["citySession"] = citySession };
        }

        // purchase_dev_node {name}: buys one node through the game's own DevTreeSystem.Purchase.
        private JObject PurchaseDevNode(JObject args)
        {
            RequireControl(); var w = RequireCity(); var system = w.GetExistingSystemManaged<DevTreeSystem>() ?? throw new InvalidOperationException("dev_tree_system_missing");
            string name = (string)args["name"] ?? throw new ArgumentException("name_required");
            var node = ReadDevNodes(w).FirstOrDefault(n => string.Equals(n.Name, name, StringComparison.OrdinalIgnoreCase)) ?? throw new ArgumentException("dev_node_not_found: " + name);
            int before = system.points; string why = DevTreeRules.CanBuy(node.Bought, node.ServiceOpen, node.RequirementsMet, node.Cost, before);
            if (why != null) throw new InvalidOperationException("dev_node_" + why);
            system.Purchase(node.Entity);
            return new JObject { ["requested"] = true, ["name"] = node.Name, ["service"] = node.Service, ["cost"] = node.Cost, ["pointsBefore"] = before, ["note"] = "the unlock is applied at the end of the frame: read dev_tree again to confirm" };
        }
    }
}
