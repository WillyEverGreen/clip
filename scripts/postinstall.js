const { execSync } = require('child_process');
const path = require('path');

const npm = process.env.npm_execpath ? `node "${process.env.npm_execpath}"` : 'npm';

try {
  console.log('Installing frontend dependencies...');
  execSync(`${npm} install`, {
    cwd: path.join(__dirname, '..', 'frontend'),
    stdio: 'inherit',
    shell: true
  });

  console.log('Installing worker dependencies...');
  execSync(`${npm} install`, {
    cwd: path.join(__dirname, '..', 'worker'),
    stdio: 'inherit',
    shell: true
  });
} catch (err) {
  console.error('Postinstall installation failed:', err);
  process.exit(1);
}

// Private admin modules are git-ignored on purpose. Give a fresh checkout placeholders so the
// app builds; the real files, when present, are left untouched.
const fs = require('fs');
const privateFiles = [
  ['worker/src/handlers/admin.ts', 'worker/src/handlers/admin.stub.ts'],
  ['frontend/src/pages/AdminPage.tsx', 'frontend/src/pages/AdminPage.stub.tsx'],
];
const root = path.join(__dirname, '..');
for (const [target, stub] of privateFiles) {
  const targetPath = path.join(root, target);
  if (!fs.existsSync(targetPath)) {
    fs.copyFileSync(path.join(root, stub), targetPath);
    console.log(`Created placeholder ${target} (private module not present)`);
  }
}
