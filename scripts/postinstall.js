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
