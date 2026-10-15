import fs from 'fs';

const files = [
  'app/group/create-members.tsx',
  'app/group/create.tsx',
  'app/group/[id].tsx',
  'app/friend/[id].tsx',
  'app/friends/index.tsx',
];

const TAG_RE = /<TouchableOpacity\b([\s\S]*?)>/g;

for (const path of files) {
  let content = fs.readFileSync(path, 'utf-8');

  // Decide, in order, whether each opening tag should convert (skip backdrop tags with bg-black/40)
  const decisions = [];
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(content)) !== null) {
    decisions.push(!m[1].includes('bg-black/40'));
  }

  const tagIter = [...content.matchAll(/<(\/?)TouchableOpacity\b/g)];
  const stack = [];
  const replacements = [];
  let oi = 0;
  for (const tm of tagIter) {
    const isClose = tm[1] === '/';
    if (!isClose) {
      const convert = decisions[oi++];
      stack.push(convert);
      if (convert) {
        replacements.push([tm.index, tm.index + tm[0].length, '<AnimatedPressable']);
      }
    } else {
      const convert = stack.pop();
      if (convert) {
        replacements.push([tm.index, tm.index + tm[0].length, '</AnimatedPressable']);
      }
    }
  }

  replacements.sort((a, b) => b[0] - a[0]);
  for (const [start, end, text] of replacements) {
    content = content.slice(0, start) + text + content.slice(end);
  }

  const converted = decisions.filter(Boolean).length;
  const kept = decisions.length - converted;
  console.log(`${path}: converted=${converted} kept_as_TouchableOpacity(backdrop)=${kept}`);

  fs.writeFileSync(path, content, 'utf-8');
}
