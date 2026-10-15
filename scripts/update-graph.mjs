import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

console.log('🔄 Building Kinlo 3D Knowledge Graph & AI Reports...');

// Helper to recursively collect files
function getFiles(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const files = fs.readdirSync(dir);
  for (const file of files) {
    if (file.startsWith('.')) continue;
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      getFiles(filePath, fileList);
    } else {
      fileList.push(filePath);
    }
  }
  return fileList;
}

// 1. Scan Repositories Layers
const appFiles = getFiles(path.join(rootDir, 'app')).map(p => path.relative(rootDir, p).replace(/\\/g, '/'));
const componentFiles = getFiles(path.join(rootDir, 'components')).map(p => path.relative(rootDir, p).replace(/\\/g, '/'));
const libFiles = getFiles(path.join(rootDir, 'lib')).map(p => path.relative(rootDir, p).replace(/\\/g, '/'));
const contextFiles = getFiles(path.join(rootDir, 'context')).map(p => path.relative(rootDir, p).replace(/\\/g, '/'));
const migrationFiles = getFiles(path.join(rootDir, 'supabase/migrations')).map(p => path.relative(rootDir, p).replace(/\\/g, '/'));
const functionFiles = getFiles(path.join(rootDir, 'supabase/functions')).map(p => path.relative(rootDir, p).replace(/\\/g, '/'));

const totalCount = appFiles.length + componentFiles.length + libFiles.length + contextFiles.length + migrationFiles.length + functionFiles.length;

// Build JSON report for AI consumption
const aiReportData = {
  timestamp: new Date().toISOString(),
  totalFiles: totalCount,
  layers: {
    appScreens: appFiles,
    components: componentFiles,
    businessLogic: libFiles,
    context: contextFiles,
    migrations: migrationFiles,
    edgeFunctions: functionFiles
  }
};

const docsDir = path.join(rootDir, 'docs');
if (!fs.existsSync(docsDir)) {
  fs.mkdirSync(docsDir, { recursive: true });
}

// Write graph.json
fs.writeFileSync(path.join(docsDir, 'graph.json'), JSON.stringify(aiReportData, null, 2));

// Write GRAPH_REPORT.md
const graphReportMd = [
  '# Kinlo — Automated Architecture & Graph Report',
  `> **Last Generated:** ${new Date().toLocaleString()}`,
  '',
  '## 📊 Repository Summary',
  `- **Total Tracked System Nodes:** ${totalCount}`,
  `- **UI Screens (\`app/\`):** ${appFiles.length}`,
  `- **Components (\`components/\`):** ${componentFiles.length}`,
  `- **Business Logic (\`lib/\` & \`context/\`):** ${libFiles.length + contextFiles.length}`,
  `- **SQL Migrations (\`supabase/migrations/\`):** ${migrationFiles.length}`,
  `- **Edge Functions (\`supabase/functions/\`):** ${functionFiles.length}`,
  '',
  '---',
  '',
  '## 📱 Active App Routes & Screens',
  appFiles.map(f => `- \`${f}\``).join('\n'),
  '',
  '---',
  '',
  '## ⚡ Core Business Logic & Math Libraries',
  libFiles.map(f => `- \`${f}\``).join('\n'),
  '',
  '---',
  '',
  '## 📜 Database Migrations Timeline (0001 - 0050)',
  migrationFiles.map(f => `- \`${f}\``).join('\n')
].join('\n');

fs.writeFileSync(path.join(docsDir, 'GRAPH_REPORT.md'), graphReportMd);

console.log('✅ Generated docs/graph.json');
console.log('✅ Generated docs/GRAPH_REPORT.md');
console.log('✨ Kinlo Knowledge Graph dataset updated successfully!');
