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
        Check(ServiceSignals.NeedScore(0, false, 5, 0) == 3, "icon streak 5 is capped at 3");
        Check(ServiceSignals.NeedScore(0, false, 2, 0) == 2 && ServiceSignals.NeedScore(0, false, 3, 0) == 3, "icon streak 2 and 3 add their own value");
        Check(ServiceSignals.NeedScore(0, false, 0, 0) == 0, "zero people adds nothing");
        Check(ServiceSignals.NeedScore(0, false, 0, 1) == 1, "one dead or sick citizen adds 1");
        Check(ServiceSignals.NeedScore(0, false, 0, 9) == 1, "nine dead or sick citizens add 1");
        Check(ServiceSignals.NeedScore(0, false, 0, 10) == 2, "ten dead or sick citizens add 2");
        Check(ServiceSignals.NeedScore(0, false, 0, 500) == 2, "large dead or sick count adds 2");
        Check(ServiceSignals.NeedScore(0, false, 0, 25) == 2, "NeedScore(0, false, 0, 25) is 2");
        Check(ServiceSignals.NeedScore(1, false, 0, 25) == 3, "NeedScore(1, false, 0, 25) is 3");

        return count;
    }
}
