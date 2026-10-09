using System;
using Newtonsoft.Json.Linq;

namespace CitiesIIAgentBridge
{
    internal static class SimulationArguments
    {
        // Validate every guard before observations, operation acquisition or unpausing.
        internal static JObject Normalize(JObject input)
        {
            if (input == null) throw new ArgumentException("simulation_arguments_required");
            var result = (JObject)input.DeepClone();
            long frames = Integer(input, "frames", 4096);
            double wall = Number(input, "wallSeconds", 30);
            double stall = Number(input, "stallSeconds", Math.Min(5, wall));
            double speed = Number(input, "speed", 4);
            if (frames < 1 || frames > 262144 || wall < 1 || wall > 60 || stall < 1 || stall > wall)
                throw new ArgumentException("invalid_simulation_bounds");
            if (speed != 1 && speed != 2 && speed != 4) throw new ArgumentException("step_speed_must_be_1_2_or_4");
            result["frames"] = frames; result["wallSeconds"] = wall; result["stallSeconds"] = stall; result["speed"] = speed;
            foreach (string flag in new[] { "acknowledgeNoProgress", "stopOnDemandChange", "stopOnNewShortage", "stopOnConstructionComplete" })
            {
                if (input[flag] != null && input[flag].Type != JTokenType.Boolean) throw new ArgumentException("boolean_required: " + flag);
                result[flag] = input[flag] ?? new JValue(flag == "stopOnNewShortage");
            }
            if (input["cashFloor"] != null) result["cashFloor"] = Integer(input, "cashFloor", 0);
            if (input["populationChange"] != null)
            {
                long n = Integer(input, "populationChange", 0);
                if (n < 1 || n > int.MaxValue) throw new ArgumentException("populationChange_must_be_positive_integer");
                result["populationChange"] = n;
            }
            return result;
        }
        internal static string OperationId(JObject args)
        {
            if (args?["id"]?.Type != JTokenType.String || !Guid.TryParseExact((string)args["id"], "N", out _))
                throw new ArgumentException("simulation_operation_id_required");
            return (string)args["id"];
        }
        private static long Integer(JObject args, string key, long fallback)
        {
            if (args[key] == null) return fallback;
            if (args[key].Type != JTokenType.Integer) throw new ArgumentException("integer_required: " + key);
            try { return (long)args[key]; } catch (OverflowException) { throw new ArgumentException("integer_out_of_range: " + key); }
        }
        private static double Number(JObject args, string key, double fallback)
        {
            if (args[key] == null) return fallback;
            if (args[key].Type != JTokenType.Float && args[key].Type != JTokenType.Integer) throw new ArgumentException("number_required: " + key);
            double value = (double)args[key];
            if (double.IsNaN(value) || double.IsInfinity(value)) throw new ArgumentException("finite_number_required: " + key);
            return value;
        }
    }
}
