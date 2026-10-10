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
            return null;
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
}
