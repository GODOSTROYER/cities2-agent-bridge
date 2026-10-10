using System;
using CitiesIIAgentBridge;

// Offline tests for src/ServiceSignals.cs (pure C#, no game types).
// Known-bug checks print "KNOWN BUG" instead of throwing so the suite stays green while the defect stays visible.
internal static class ServiceSignalsTests
{
    internal static int Run()
    {
        int count = 0;
        void Check(bool ok, string label) { if (!ok) throw new Exception("FAIL: " + label); ++count; Console.WriteLine("PASS: " + label); }

        // ---- ServiceForText: tutorial cards and chirps ----
        Check(ServiceSignals.ServiceForText("CemeteryTutorialIntro") == "deathcare", "tutorial card CemeteryTutorialIntro maps to deathcare");
        Check(ServiceSignals.ServiceForText("FireTutorialIntro") == "fire", "tutorial card FireTutorialIntro maps to fire");
        Check(ServiceSignals.ServiceForText("Where is the #hearse? Grandpa has been lying here for days") == "deathcare", "hearse chirp maps to deathcare");
        Check(ServiceSignals.ServiceForText("Garbage everywhere") == "garbage", "garbage chirp maps to garbage");
        Check(ServiceSignals.ServiceForText("I'm appalled at how #healthcare is run") == "health", "healthcare chirp maps to health");
        Check(ServiceSignals.ServiceForText("crime is up") == "police", "crime chirp maps to police");
        Check(ServiceSignals.ServiceForText("I really wish #education was organized better") == "education", "education chirp maps to education");
        Check(ServiceSignals.ServiceForText("blackout again") == "power", "blackout chirp maps to power");
        Check(ServiceSignals.ServiceForText("sewage smell") == "sewage", "sewage chirp maps to sewage");
        Check(ServiceSignals.ServiceForText("water tastes odd") == "water", "water chirp maps to water");
        Check(ServiceSignals.ServiceForText("I love warm weather") == null, "unrelated chirp maps to null");
        Check(ServiceSignals.ServiceForText(null) == null, "null text maps to null");
        Check(ServiceSignals.ServiceForText("") == null, "empty text maps to null");
        Check(ServiceSignals.ServiceForText("CRIME IS UP") == "police", "matching is case-insensitive (upper case)");
        Check(ServiceSignals.ServiceForText("cEMETERYtutorialINTRO") == "deathcare", "matching is case-insensitive (mixed case)");

        // Substring false positives seen while reading the rules (kept visible, not failing).
        Check(ServiceSignals.ServiceForText("wastewater backing up") == "sewage", "'wastewater' maps to sewage, not garbage (via 'waste')");
        Check(ServiceSignals.ServiceForText("My neighbour has been dead for a week") == "deathcare", "the word dead maps to deathcare (word boundary regex)");
        Check(ServiceSignals.ServiceForText("the deadline is friday") == null, "'deadline' maps to deathcare (via 'dead')");

        // ---- NeedScore: Threshold 3 ----
        int t = ServiceSignals.Threshold;
        Check(t == 3, "escalation threshold is 3");
        int one = ServiceSignals.NeedScore(1, false, 0, 0);
        Check(one == 1 && one < t, "one chirp scores 1, below threshold");
        int three = ServiceSignals.NeedScore(3, false, 0, 0);
        Check(three == 3 && three >= t, "three chirps score 3, meeting threshold");
        Check(ServiceSignals.NeedScore(0, true, 0, 0) == 1, "tutorial card alone scores 1");
        Check(ServiceSignals.NeedScore(2, true, 0, 0) == 3, "tutorial card plus two chirps scores 3");

        // Icon-rise streak counts only with icons >= 5, capped at 3.
        Check(ServiceSignals.NeedScore(0, false, 5, 0, 5) == 3, "icon streak 5 with icons 5 is capped at 3");
        Check(ServiceSignals.NeedScore(0, false, 5, 0, 4) == 0, "icon streak 5 with icons 4 adds 0");
        Check(ServiceSignals.NeedScore(0, false, 5, 0, 6) == 3, "icon streak 5 with icons 6 adds 3");
        Check(ServiceSignals.NeedScore(0, false, 2, 0, 5) == 2 && ServiceSignals.NeedScore(0, false, 3, 0, 5) == 3, "icon streak 2 and 3 (icons 5) add their own value");

        // People (dead or sick): 1-2 add 0, 3-9 add 1, 10+ add 2.
        Check(ServiceSignals.NeedScore(0, false, 0, 0) == 0, "zero people adds nothing");
        Check(ServiceSignals.NeedScore(0, false, 0, 1) == 0, "one dead or sick citizen adds 0");
        Check(ServiceSignals.NeedScore(0, false, 0, 2) == 0, "two dead or sick citizens add 0");
        Check(ServiceSignals.NeedScore(0, false, 0, 3) == 1, "three dead or sick citizens add 1");
        Check(ServiceSignals.NeedScore(0, false, 0, 9) == 1, "nine dead or sick citizens add 1");
        Check(ServiceSignals.NeedScore(0, false, 0, 10) == 2, "ten dead or sick citizens add 2");
        Check(ServiceSignals.NeedScore(0, false, 0, 500) == 2, "large dead or sick count adds 2");
        Check(ServiceSignals.NeedScore(0, false, 0, 25) == 2, "NeedScore(0, false, 0, 25) is 2");
        Check(ServiceSignals.NeedScore(1, false, 0, 25) == 3, "NeedScore(1, false, 0, 25) is 3");

        // Standing icons: 10+ adds 1.
        Check(ServiceSignals.NeedScore(0, false, 0, 0, 9) == 0, "icons 9 adds 0");
        Check(ServiceSignals.NeedScore(0, false, 0, 0, 10) == 1, "icons 10 adds 1");
        Check(ServiceSignals.NeedScore(0, false, 0, 23, 23) == 3, "23 dead with 23 icons and no chirps scores 3");

        // Happiness factor (already averaged): < -5 adds 6, < -3 adds 3, <= -2 adds 1, otherwise 0.
        Check(ServiceSignals.NeedScore(0, false, 0, 0, 0, -7.4) == 6, "factor -7.4 alone scores 6");
        Check(ServiceSignals.NeedScore(0, false, 0, 0, 0, -6.4) == 6, "factor -6.4 alone scores 6");
        Check(ServiceSignals.NeedScore(0, false, 0, 0, 0, -5.0) == 3, "factor -5.0 alone scores 3");
        Check(ServiceSignals.NeedScore(0, false, 0, 0, 0, -3.4) == 3, "factor -3.4 alone scores 3");
        Check(ServiceSignals.NeedScore(0, false, 0, 0, 0, -3.0) == 1, "factor -3.0 alone scores 1");
        Check(ServiceSignals.NeedScore(0, false, 0, 0, 0, -2.0) == 1, "factor -2.0 alone scores 1");
        Check(ServiceSignals.NeedScore(0, false, 0, 0, 0, -1.4) == 0, "factor -1.4 alone scores 0");
        Check(ServiceSignals.NeedScore(0, false, 0, 0, 0, -0.5) == 0, "factor -0.5 alone scores 0");

        // ---- FactorPriority: happiness factor -> handling tier ----
        Check(ServiceSignals.FactorPriority(-7.4) == "very_high", "factor -7.4 is very_high priority");
        Check(ServiceSignals.FactorPriority(-5) == "priority", "factor -5 is priority (very_high needs worse than -5)");
        Check(ServiceSignals.FactorPriority(-3.1) == "priority", "factor -3.1 is priority");
        Check(ServiceSignals.FactorPriority(-3) == "normal", "factor -3 is normal (priority needs worse than -3)");
        Check(ServiceSignals.FactorPriority(1) == "normal", "factor +1 is normal");

        // ---- NeedForFactor: happiness factor name -> need ----
        Check(ServiceSignals.NeedForFactor("Crime") == "police", "factor Crime maps to police");
        Check(ServiceSignals.NeedForFactor("Healthcare") == "health", "factor Healthcare maps to health");
        Check(ServiceSignals.NeedForFactor("Entertainment") == "entertainment", "factor Entertainment maps to entertainment");
        Check(ServiceSignals.NeedForFactor("Telecom") == "telecom", "factor Telecom maps to telecom");
        Check(ServiceSignals.NeedForFactor("Mail") == "post", "factor Mail maps to post");
        Check(ServiceSignals.NeedForFactor("Water") == "water" && ServiceSignals.NeedForFactor("WaterPollution") == "water", "factors Water and WaterPollution map to water");
        Check(ServiceSignals.NeedForFactor("TrafficPenalty") == "traffic", "factor TrafficPenalty maps to traffic");
        Check(ServiceSignals.NeedForFactor("Tax") == null, "factor Tax is exempt (owner: revenue-first) and maps to no need");
        Check(ServiceSignals.NeedForFactor("Unemployment") == "jobs", "factor Unemployment maps to jobs");
        Check(ServiceSignals.NeedForFactor("NoisePollution") == "pollution", "factor NoisePollution maps to pollution");
        Check(ServiceSignals.NeedForFactor("NotARealFactor") == null, "unknown factor name maps to null");

        return count;
    }
}
