import express from 'express';
import { authMiddleware } from './authMiddleware';
import zod from 'zod';
import { compressString, decompressString } from './compression';

const taskInstructionsSchema = zod.object({
  instructions: zod.string(),
});

export function taskInstructionRouter(): express.Router {
  const router = express.Router();

  router.post('/create-task-instructions', authMiddleware, async (req, res) => {
    const { logger, subscription } = res.locals;

    try {
      const parseResult = taskInstructionsSchema.parse(req.body);
      const instructions = parseResult.instructions;

      // Compress instructions before saving to reduce storage size.
      // Existing rows without this prefix will still be readable
      // via decompressString for backwards compatibility.
      subscription.taskInstructions = compressString(instructions);
      await subscription.save();
      res.json({ message: 'Task instructions saved' });
    } catch (err) {
      logger.error('Error saving task instructions.', { error: err });
      res.status(500).json({ error: 'Failed to save task instructions.' });
    }
  });

  router.get('/get-task-instructions', authMiddleware, async (req, res) => {
    const { logger, subscription } = res.locals;
    try {
      const decompressed = decompressString(subscription.taskInstructions) ?? '';
      res.json({ instructions: decompressed });
    } catch (err) {
      logger.error('Error retrieving task instructions.', { error: err });
      res.status(500).json({ error: 'Failed to retrieve task instructions.' });
    }
  });

  return router;
}
