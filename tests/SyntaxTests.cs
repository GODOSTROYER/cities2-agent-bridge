using System;
using System.IO;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

if(args.Length!=1)throw new ArgumentException("Usage: SyntaxTests source-directory");
var files=Directory.GetFiles(args[0],"*.cs");
if(files.Length==0)throw new Exception("No native source files found");
int errors=0;
foreach(string file in files)
{
    var tree=CSharpSyntaxTree.ParseText(File.ReadAllText(file),new CSharpParseOptions(LanguageVersion.CSharp9),file);
    foreach(var error in tree.GetDiagnostics().Where(d=>d.Severity==DiagnosticSeverity.Error))
    {Console.Error.WriteLine(error.ToString());++errors;}
}
Console.WriteLine($"C# 9 syntax: {files.Length} source files; {errors} errors. This is NOT native API/type checking or live-game validation.");
return errors==0?0:1;
