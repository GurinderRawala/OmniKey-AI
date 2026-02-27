import express from 'express';
import { Subscription } from './models/subscription';
import { authMiddleware } from './authMiddleware';
import zod from 'zod';
import { compressString, decompressString } from './compression';

const taskInstructionsSchema = zod.object({
  instructions: zod.string(),
});

export function taskInstructionRouter(): express.Router {
  const router = express.Router();

  router.post('/create-task-instructions', authMiddleware, async (req, res) => {
    const {
      logger,
      subscription: { sid },
    } = res.locals;

    try {
      const parseResult = taskInstructionsSchema.parse(req.body);
      const instructions = parseResult.instructions;
      const subscription = await Subscription.findByPk(sid);
      if (!subscription) {
        logger.warn('Subscription not found for create-task-instructions.', {
          subscriptionId: sid,
        });
        return res.status(404).json({ error: 'Subscription not found.' });
      }

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
    const { logger } = res.locals;
    try {
      const subscription = await Subscription.findByPk(res.locals.subscription.sid);
      if (!subscription) {
        logger.warn('Subscription not found for get-task-instructions.', {
          subscriptionId: res.locals.subscription.sid,
        });
        return res.status(404).json({ error: 'Subscription not found.' });
      }

      const decompressed = decompressString(subscription.taskInstructions) ?? '';
      res.json({ instructions: decompressed });
    } catch (err) {
      logger.error('Error retrieving task instructions.', { error: err });
      res.status(500).json({ error: 'Failed to retrieve task instructions.' });
    }
  });

  return router;
}
