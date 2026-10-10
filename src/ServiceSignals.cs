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
            if (t.Contains("cemetery") || t.Contains("deathcare") || t.Contains("hearse") || t.Contains("crematorium") || System.Text.RegularExpressions.Regex.IsMatch(t, "\bdead\b") || t.Contains("funeral")) return "deathcare";
            if (t.Contains("fire") || t.Contains("burn")) return "fire";
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
        // + 1 if any dead/sick citizens (2 if >= 10). score >= 3 -> "build": ahead of growth,
        // overriding upkeep discipline.
        internal static int NeedScore(int chirps, bool tutorial, int iconStreak, int people)
            => chirps + (tutorial ? 1 : 0) + Math.Min(3, iconStreak) + (people >= 10 ? 2 : people > 0 ? 1 : 0);
    }
}
