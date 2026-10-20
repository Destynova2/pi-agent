import { withIndexLock } from '../../lock.ts';

await withIndexLock(process.argv[2], async () => {
  process.stdout.write('locked\n');
  await new Promise(resolve => {
    process.stdin.once('end', resolve);
    process.stdin.resume();
  });
});
