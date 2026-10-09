using System.Collections.Generic;
using Colossal;
using Colossal.IO.AssetDatabase;
using Game.Modding;
using Game.Settings;

namespace CitiesIIAgentBridge
{
    // Persisted under ModsSettings so the owner's opt-in survives game restarts.
    [FileLocation("ModsSettings/CitiesIIAgentBridge/CitiesIIAgentBridge")]
    public sealed class BridgeSettings : ModSetting
    {
        public BridgeSettings(IMod mod) : base(mod) { SetDefaults(); }

        [SettingsUISection("Main", "Control")]
        public bool AllowControl { get; set; }

        // Owner opt-in: skip the safety reset of AllowControl when a city loads.
        [SettingsUISection("Main", "Control")]
        public bool KeepControlsAcrossLoads { get; set; }

        public override void SetDefaults() { AllowControl = false; KeepControlsAcrossLoads = false; }
    }

    public sealed class LocaleEN : IDictionarySource
    {
        private readonly BridgeSettings settings;
        public LocaleEN(BridgeSettings settings) { this.settings = settings; }
        public IEnumerable<KeyValuePair<string, string>> ReadEntries(IList<IDictionaryEntryError> errors, Dictionary<string, int> indexCounts)
        {
            return new Dictionary<string, string>
            {
                { settings.GetSettingsLocaleID(), "Cities II Agent Bridge" },
                { settings.GetOptionTabLocaleID("Main"), "Bridge" },
                { settings.GetOptionGroupLocaleID("Control"), "Local control" },
                { settings.GetOptionLabelLocaleID(nameof(BridgeSettings.AllowControl)), "Allow local bridge controls" },
                { settings.GetOptionDescLocaleID(nameof(BridgeSettings.AllowControl)), "Allow construction, demolition, zoning, tile purchases, budgets, taxes, saves, and camera/simulation commands. Analysis commands pause the city. Bounded simulation steps pause when they finish or time out. Construction uses native placement checks and spending limits. Off after loading a city unless kept on below. With controls off, pause the city manually before inspection." },
                { settings.GetOptionLabelLocaleID(nameof(BridgeSettings.KeepControlsAcrossLoads)), "Keep bridge controls enabled across city loads" },
                { settings.GetOptionDescLocaleID(nameof(BridgeSettings.KeepControlsAcrossLoads)), "When on, loading any city (including other saves) keeps local bridge controls enabled and the choice persists across game restarts. Any local program that can write the bridge mailbox can then change the loaded city. The STOP latch and the checkbox above still turn controls off." }
            };
        }
        public void Unload() { }
    }
}


