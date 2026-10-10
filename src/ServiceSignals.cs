using System;

namespace CitiesIIAgentBridge
{
    // Pure service-signal rules (unit-tested offline).
    internal static class ServiceSignals
    {
        internal const int Threshold = 3;

        // Tutorial intro cards are the game asking for a service (CemeteryTutorialIntro -> deathcare).
        internal static string ServiceForText(string text)
        {
            if (string.IsNullOrEmpty(text)) return null;
            string t = text.ToLowerInvariant();
            if (t.Contains("cemetery") || t.Contains("deathcare") || t.Contains("hearse") || t.Contains("crematorium") || System.Text.RegularExpressions.Regex.IsMatch(t, @"\bdead\b") || t.Contains("funeral")) return "deathcare";
            if (t.Contains("fire") || t.Contains("burn")) return "fire";
            if (t.Contains("traffic") || t.Contains("bottleneck")) return "traffic";
            if (t.Contains("noise")) return "pollution";
            if (t.Contains("collapsed") || t.Contains("destroyed")) return "ruins";
            if (t.Contains("abandon")) return "abandoned";
            if (t.Contains("sewage") || t.Contains("wastewater")) return "sewage";
            if (t.Contains("garbage") || t.Contains("landfill") || t.Contains("trash") || t.Contains("waste")) return "garbage";
            if (t.Contains("health") || t.Contains("clinic") || t.Contains("hospital") || t.Contains("sick") || t.Contains("doctor")) return "health";
            if (t.Contains("police") || t.Contains("crime") || t.Contains("robb") || t.Contains("theft")) return "police";
            if (t.Contains("school") || t.Contains("education") || t.Contains("university")) return "education";
            if (t.Contains("electric") || t.Contains("power") || t.Contains("blackout")) return "power";
            if (t.Contains("sewage")) return "sewage";
            if (t.Contains("water")) return "water";
            if (t.Contains("mail") || t.Contains("post")) return "post";
            if (t.Contains("pollution")) return "pollution";
            return null;
        }

        // Network warnings (FAILURES #77): a cable, pipe or road whose end is not joined to
        // anything ("Powerline Not Connected", "Pipeline Not Connected", "Dead End",
        // "Road Connection"...). They are always immediate: one icon is a broken network.
        internal static bool IsNetworkWarning(string type)
        {
            if (string.IsNullOrEmpty(type)) return false;
            string t = type.ToLowerInvariant();
            // "Road Outside Connection" and its siblings are map markers, not warnings.
            if (t.EndsWith("outside connection") && !t.StartsWith("no ")) return false;
            return t.Contains("not connected") || t.Contains("dead end") || t.Contains("deadend") || t.Contains("connection") || t.Contains("no outlet") || t.Contains("no inlet");
        }

        // Persistent icons escalate by duration and count (FAILURES #78): five garbage icons sat
        // at 0/3 for hours because only a RISING count scored. framesPresent = simulation frames
        // the need has had at least one icon without a break (262,144 frames = one game day).
        internal static int PersistencePoints(int icons, long framesPresent)
        {
            if (icons <= 0) return 0;
            if (framesPresent >= 65536) return icons >= 3 ? 3 : 2;
            if (framesPresent >= 16384) return icons >= 3 ? 1 : 0;
            return 0;
        }

        // Every notification icon maps to a need (rule E): the known services first, then the
        // remaining icon families, and "inspect" for a type nobody has mapped yet, so an icon
        // cluster is never silently dropped.
        internal static string NeedForIcon(string type)
        {
            if (IsNetworkWarning(type)) return "network";
            if (type != null && type.StartsWith("Electricity", StringComparison.OrdinalIgnoreCase)) return "power"; // "Electricity Bottleneck" is not traffic
            string known = ServiceForText(type); if (known != null) return known;
            string t = (type ?? "").ToLowerInvariant();
            if (t.Contains("road") || t.Contains("pedestrian") || t.Contains("dead end") || t.Contains("connection") || t.Contains("track")) return "access";
            if (t.Contains("ambulance") || t.Contains("medical")) return "health";
            if (t.Contains("battery") || t.Contains("transformer") || t.Contains("voltage")) return "power";
            if (t.Contains("pipe") || t.Contains("flood")) return "water";
            if (t.Contains("rent") || t.Contains("homeless") || t.Contains("condemned")) return "housing";
            if (t.Contains("customer") || t.Contains("resource") || t.Contains("labor") || t.Contains("worker") || t.Contains("employee") || t.Contains("bankrupt")) return "economy";
            if (t.Contains("park") || t.Contains("bus") || t.Contains("train") || t.Contains("taxi") || t.Contains("tram") || t.Contains("subway") || t.Contains("ship") || t.Contains("airplane") || t.Contains("route") || t.Contains("vehicle")) return "transport";
            return "inspect";
        }

        // Escalation (owner rule): one chirp is noise. score = chirps among the 10 newest
        // + 1 for a tutorial card asking for it + icon-rise streak across snapshots (max 3)
        // + 1 if any dead/sick citizens (2 if >= 10) + 1 for a standing 10+ notification icons. score >= 3 -> "build": ahead of growth,
        // overriding upkeep discipline.
        // Owner rule for happiness factors (each is already a 16-frame average over every citizen,
        // so a negative value is a sustained signal):
        //   worse than -5  -> very_high: act immediately, before everything except popups and
        //                     critical utilities, and keep acting each cycle until it improves
        //   worse than -3  -> priority: act this cycle, ahead of growth
        //   -3 or better   -> normal handling (it only adds 1 point from -2 down)
        internal static string FactorPriority(double factor) => factor < -5 ? "very_high" : factor < -3 ? "priority" : "normal";

        // A lone wobble does not escalate: icon rises only count from 5 icons up, and 1-2 dead or
        // sick citizens add nothing.
        internal static int NeedScore(int chirps, bool tutorial, int iconStreak, int people, int icons = 0, double factor = 0)
            => chirps + (tutorial ? 1 : 0) + (icons >= 5 ? Math.Min(3, iconStreak) : 0) + (people >= 10 ? 2 : people >= 3 ? 1 : 0) + (icons >= 10 ? 1 : 0)
               + (factor < -5 ? 6 : factor < -3 ? 3 : factor <= -2 ? 1 : 0);

        // CitizenHappinessSystem.HappinessFactor name -> the need it asks for.
        internal static string NeedForFactor(string factor)
        {
            switch (factor)
            {
                case "Crime": return "police";
                case "Healthcare": return "health";
                case "DeathPenalty": return "deathcare";
                case "Entertainment": return "entertainment";
                case "Telecom": return "telecom";
                case "Garbage": return "garbage";
                case "Education": return "education";
                case "Mail": return "post";
                case "Welfare": return "welfare";
                case "Electricity": return "power";
                case "Water": case "WaterPollution": return "water";
                case "Sewage": return "sewage";
                case "TrafficPenalty": return "traffic";
                // Tax is exempt by owner decision: rates are set to maximise income, so this factor is
                // reported but never escalates and never becomes a need.
                case "Tax": return null;
                case "Unemployment": return "jobs";
                case "Homelessness": return "housing";
                case "AirPollution": case "GroundPollution": case "NoisePollution": return "pollution";
                default: return null;
            }
        }
    }

    // Pure utility-shortage rules (A and B), unit-tested offline.
    internal static class UtilitySignals
    {
        internal const double CapacityPct = 95;

        // unserved = buildings without the utility; streak = snapshots in a row with any.
        // A shortage is never "watch": the first snapshot says "confirm" (a building that has just
        // appeared may still be hooking up), from the second it is an action. The cause decides
        // which: not joined to the main network -> "connect"; joined but the city uses 95%+ of
        // what it makes -> "build" (capacity); joined with spare capacity -> "connect" with
        // cause "local" (a break or bottleneck near the buildings).
        internal static (string action, string cause, int score) Need(int unserved, int streak, double usePct, bool linked)
        {
            if (unserved <= 0) return ("none", null, 0);
            string cause = !linked ? "connection" : usePct >= CapacityPct ? "capacity" : "local";
            string action = streak < 2 ? "confirm" : cause == "capacity" ? "build" : "connect";
            return (action, cause, ServiceSignals.Threshold + unserved);
        }

        internal static string Say(string utility, string cause, int unserved, double x, double z)
        {
            string where = "(" + x + "," + z + ")";
            if (cause == "capacity") return "build more " + utility + " capacity: " + unserved + " buildings short, the city uses nearly all it makes";
            if (cause == "connection") return "connect district at " + where + ": " + unserved + " buildings have no " + utility + " and are not joined to the city network";
            return "check the " + utility + " network near " + where + ": " + unserved + " buildings short although the district is joined and capacity is spare";
        }

        // A cable or pipe end is loose when only its own edge arrives there (nothing to carry
        // the utility on). A road end like that is an ordinary dead end and fine, unless the
        // road is an island cut off from the main road network.
        internal static bool LooseEnd(bool road, int edgesAtNode, bool island) => road ? island : edgesAtNode <= 1;

        // utility_check verdict for a new district.
        internal static string Verdict(bool linked, int buildings, int unserved)
            => !linked ? "not_connected" : unserved > 0 ? "unserved" : buildings == 0 ? "connected_no_buildings_yet" : "served";
    }
}
