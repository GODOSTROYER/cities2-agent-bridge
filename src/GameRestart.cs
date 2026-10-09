using System;
using System.IO;
using System.Linq;
using Game.SceneFlow;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace CitiesIIAgentBridge
{
    // Lets an authorised agent restart the game for upgrades without the owner. Refuses
    // unless the caller names a save file written within the last 5 minutes, so the
    // newest progress is on disk before the game exits.
    public sealed partial class Mod
    {
        private JObject QuitGameAfterSave(JObject args)
        {
            // At the main menu there is no city to lose; quitting needs no save.
            if (GameManager.instance.gameMode != Game.GameMode.Game)
            {
                log.Info("Quit requested by bridge at " + GameManager.instance.gameMode);
                GameManager.QuitGame();
                return new JObject { ["quitting"] = true, ["gameMode"] = GameManager.instance.gameMode.ToString() };
            }
            RequireControl();
            string saveName = (string)args["afterSave"];
            if (string.IsNullOrEmpty(saveName)) throw new ArgumentException("afterSave_required: name of a save written in the last 5 minutes");
            var root = Path.Combine(Application.persistentDataPath, "Saves");
            var file = Directory.Exists(root) ? Directory.EnumerateFiles(root, saveName + ".cok", SearchOption.AllDirectories).FirstOrDefault() : null;
            if (file == null) throw new InvalidOperationException("save_not_found: " + saveName);
            var age = DateTime.UtcNow - File.GetLastWriteTimeUtc(file);
            if (age > TimeSpan.FromMinutes(5)) throw new InvalidOperationException("save_too_old_minutes: " + Math.Round(age.TotalMinutes, 1));
            log.Info("Quit requested by bridge after verified save " + saveName);
            GameManager.QuitGame();
            return new JObject { ["quitting"] = true, ["afterSave"] = saveName, ["saveAgeSeconds"] = Math.Round(age.TotalSeconds) };
        }

        // Loads a save by exact name, or the newest save whose name starts with a prefix
        // (default: the bridge's rolling autosave). Main menu only, so a loaded city can
        // never be discarded. Used by upgrade.ps1 after a restart (CS2's Continue button
        // and -continuelastsave do not pick up bridge-made saves).
        private JObject LoadSave(JObject args)
        {
            RequireControl();
            if (GameManager.instance.gameMode == Game.GameMode.Game) throw new InvalidOperationException("load_save_only_from_main_menu");
            string exact = (string)args["name"];
            string prefix = (string)args["prefix"] ?? "CitiesIIAgentBridge-autosave-";
            var saves = Colossal.IO.AssetDatabase.AssetDatabase.global.GetAssets(default(Colossal.IO.AssetDatabase.SearchFilter<Game.Assets.SaveGameMetadata>)).ToList();
            var pick = exact != null
                ? saves.FirstOrDefault(s => s.name == exact)
                : saves.Where(s => s.name != null && s.name.StartsWith(prefix, StringComparison.Ordinal)).OrderByDescending(s => s.name, StringComparer.Ordinal).FirstOrDefault();
            if (pick == null) throw new InvalidOperationException("save_not_found: " + (exact ?? prefix + "*") + " (" + saves.Count + " saves known)");
            log.Info("Bridge loading save " + pick.name);
            _ = GameManager.instance.Load(Game.GameMode.Game, Colossal.Serialization.Entities.Purpose.LoadGame, pick);
            return new JObject { ["loading"] = pick.name };
        }
    }
}