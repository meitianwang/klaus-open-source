import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDirectory = fileURLToPath(new URL('..', import.meta.url)), sourceRoot = join(appDirectory, 'main');
const require = createRequire(import.meta.url), ts = require('typescript'), files = [];
function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
  }
}
collect(sourceRoot);
const program = ts.createProgram(files, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, skipLibCheck: true });
const checker = program.getTypeChecker(), producers = new Map();
// Window routing helpers are producer boundaries just like the underlying transports.
const producerCalls = new Set(['emit', 'push', 'deliver', 'send', 'broadcast', 'sendToMainWindow', 'deliverToFocusedMain']);
for (const path of files) {
  const source = program.getSourceFile(path);
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ts.isIdentifier(node.expression) ? node.expression.text : '';
      if (producerCalls.has(name)) for (const argument of node.arguments) {
        const type = checker.getTypeAtLocation(argument);
        for (const member of type.isUnion() ? type.types : [type]) {
          // Digits belong in the character classes: a channel namespace may carry a
          // version or a product number (`model3d:changed`). Omitting them made the
          // audit blind to every such producer, so the two real `model3d` emissions
          // in main/model3d/service.ts were reported as missing channels.
          if (!(member.flags & ts.TypeFlags.StringLiteral) || !/^[a-zA-Z][a-zA-Z0-9-]*:[a-zA-Z][a-zA-Z0-9:-]*$/.test(member.value)) continue;
          const locations = producers.get(member.value) ?? [];
          locations.push(`${relative(appDirectory, path)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
          producers.set(member.value, locations);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
// These are explicit internal transports, outside the renderer-facing contract.
const internal = new Set(['klaus:delivery', 'klaus:resized', 'chat:event']);
const contract = JSON.parse(readFileSync(join(appDirectory, 'contracts/channel-table.json'), 'utf8'));
const required = [...new Set(contract.roles.flatMap(role => role.push))].sort();
const missing = required.filter(channel => !producers.has(channel));
const extra = [...producers.keys()].filter(channel => !required.includes(channel) && !internal.has(channel)).sort();
console.log(JSON.stringify({ audit: 'static-push-producers', required: required.length, found: required.length - missing.length, missing, extra }));
if (process.argv.includes('--evidence')) for (const channel of required) console.log(`${channel}: ${(producers.get(channel) ?? []).join(', ') || 'MISSING'}`);
// A producer is source evidence, not proof of delivery. The application integration
// gate separately exercises actual windows, subscriptions and acknowledged delivery.
process.exitCode = missing.length || extra.length ? 1 : 0;
