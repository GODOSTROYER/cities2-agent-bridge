using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;

namespace CitiesIIAgentBridge
{
    // Main-thread registry. Origin is captured at Begin, never at status-read time.
    internal sealed class OperationRegistry
    {
        internal const int HistoryLimit = 1024;
        internal readonly Dictionary<string, JObject> Results = new Dictionary<string, JObject>();
        private readonly LinkedList<string> order = new LinkedList<string>();
        private Func<string> session, city, request;
        internal string Active { get; private set; }

        internal void Configure(Func<string> session, Func<string> city, Func<string> request)
        {
            if (Active != null) Finish(Active, "interrupted", "bridge_session_changed");
            this.session = session ?? throw new ArgumentNullException(nameof(session));
            this.city = city ?? throw new ArgumentNullException(nameof(city));
            this.request = request ?? throw new ArgumentNullException(nameof(request));
        }
        internal string Begin(string kind)
        {
            if (Active != null) throw new InvalidOperationException("construction_busy");
            string originSession = session?.Invoke(), originCity = city?.Invoke();
            if (string.IsNullOrEmpty(originSession) || string.IsNullOrEmpty(originCity))
                throw new InvalidOperationException("operation_origin_unavailable");
            // Backpressure rather than silently throwing away unresolved effects.
            var node = order.First;
            while (Results.Count >= HistoryLimit && node != null)
            {
                var next = node.Next;
                var old = Results[node.Value];
                if (!Pending(old) && ((string)old["status"] == "complete" || (bool?)old["applicationRequested"] != true))
                { Results.Remove(node.Value); order.Remove(node); }
                node = next;
            }
            if (Results.Count >= HistoryLimit) throw new InvalidOperationException("unresolved_operation_history_full");
            string id = Guid.NewGuid().ToString("N");
            Results[id] = new JObject {
                ["id"] = id, ["kind"] = kind, ["status"] = "queued",
                ["session"] = originSession, ["citySession"] = originCity, ["requestId"] = request(),
                ["createdUtc"] = DateTime.UtcNow.ToString("O"),
                ["applicationRequested"] = false, ["applicationMayHaveOccurred"] = false,
                ["applied"] = false, ["verificationState"] = "not_started", ["retryAllowed"] = false
            };
            order.AddLast(id); Active = id; return id;
        }
        internal JObject Status(string id)
        {
            if (id == null || !Results.TryGetValue(id, out var result)) throw new ArgumentException("operation_not_found");
            CheckOrigin(result);
            return (JObject)result.DeepClone();
        }
        private void CheckOrigin(JObject result)
        {
            if ((string)result["session"] != session?.Invoke()) throw new InvalidOperationException("stale_operation_session");
            if ((string)result["citySession"] != city?.Invoke()) throw new InvalidOperationException("stale_operation_city_session");
        }
        private JObject Live(string id)
        {
            if (id == null || id != Active || !Results.TryGetValue(id, out var result) || !Pending(result))
                throw new InvalidOperationException("operation_not_active");
            CheckOrigin(result); return result;
        }
        internal void Submitted(string id)
        {
            var r = Live(id);
            r["applicationRequested"] = true; r["applicationMayHaveOccurred"] = true;
            r["applied"] = JValue.CreateNull(); r["verificationState"] = "pending";
        }
        internal void Verified(string id, string evidence)
        {
            var r = Live(id);
            if ((bool?)r["applicationRequested"] != true) throw new InvalidOperationException("application_not_submitted");
            r["applied"] = true; r["verificationState"] = "verified"; r["verificationEvidence"] = evidence;
        }
        internal void Finish(string id, string status, string error = null)
        {
            if (status != "complete" && status != "failed" && status != "interrupted") throw new ArgumentException("terminal_status_required");
            // Late OnStopRunning/save callbacks cannot rewrite a terminal result.
            if (id == null || !Results.TryGetValue(id, out var r) || !Pending(r)) return;
            bool submitted = (bool?)r["applicationRequested"] == true;
            bool verified = (string)r["verificationState"] == "verified";
            if (status == "complete" && submitted && !verified)
            { status = "failed"; error = error ?? "application_not_verified"; }
            r["status"] = status; r["finishedUtc"] = DateTime.UtcNow.ToString("O");
            if (error != null) r["error"] = error;
            r["outcome"] = !submitted ? "not_submitted" : !verified ? "uncertain" : status == "complete" ? "verified" : "partial";
            if (submitted && !verified) r["verificationState"] = "unverified";
            r["retryAllowed"] = !submitted && status == "failed";
            if (submitted && status != "complete") r["recovery"] = "Inspect this operation and fresh city state; do not replay the mutation.";
            if (Active == id) Active = null;
        }
        private static bool Pending(JObject r)
        {
            string s = (string)r["status"];
            return s == "queued" || s == "validating" || s == "applying" || s == "running";
        }
    }
}
