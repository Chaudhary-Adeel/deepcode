import { DirtyTracker } from '../dirtyTracker';

describe('DirtyTracker', () => {
    test('markClean keeps file dirty if revision changed mid-index', () => {
        const tracker = new DirtyTracker('/workspace');

        const watcherHandler = (tracker as any).onFileChanged.bind(tracker) as (uri: { fsPath: string }) => void;

        watcherHandler({ fsPath: '/workspace/src/example.ts' });
        const revisionAtStart = tracker.getRevision('src/example.ts');

        watcherHandler({ fsPath: '/workspace/src/example.ts' });

        const cleaned = tracker.markClean('src/example.ts', revisionAtStart);

        expect(cleaned).toBe(false);
        expect(tracker.isDirty('src/example.ts')).toBe(true);
    });

    test('markClean clears dirty flag when revision is unchanged', () => {
        const tracker = new DirtyTracker('/workspace');

        const watcherHandler = (tracker as any).onFileChanged.bind(tracker) as (uri: { fsPath: string }) => void;

        watcherHandler({ fsPath: '/workspace/src/example.ts' });
        const revisionAtStart = tracker.getRevision('src/example.ts');

        const cleaned = tracker.markClean('src/example.ts', revisionAtStart);

        expect(cleaned).toBe(true);
        expect(tracker.isDirty('src/example.ts')).toBe(false);
    });
});