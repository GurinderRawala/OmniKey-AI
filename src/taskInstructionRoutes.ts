import express from 'express';
import { authMiddleware } from './authMiddleware';
import zod from 'zod';
import { compressString, decompressString } from './compression';
import { SubscriptionTaskTemplate } from './models/subscriptionTaskTemplate';

const taskTemplateSchema = zod.object({
  heading: zod.string().min(1).max(200),
  instructions: zod.string(),
});

export function taskInstructionRouter(): express.Router {
  const router = express.Router();

  // Task template CRUD endpoints
  router.get('/templates', authMiddleware, async (req, res) => {
    const { logger, subscription } = res.locals;

    try {
      const templates = await SubscriptionTaskTemplate.findAll({
        where: { subscriptionId: subscription.id },
        order: [['createdAt', 'ASC']],
      });

      const result = templates.map((tpl) => ({
        id: tpl.id,
        heading: tpl.heading,
        instructions: decompressString(tpl.instructions) ?? '',
        isDefault: tpl.isDefault,
      }));

      res.json({ templates: result });
    } catch (err) {
      logger.error('Error retrieving task templates.', { error: err });
      res.status(500).json({ error: 'Failed to retrieve task templates.' });
    }
  });

  router.post('/templates', authMiddleware, async (req, res) => {
    const { logger, subscription } = res.locals;

    try {
      const existingCount = await SubscriptionTaskTemplate.count({
        where: { subscriptionId: subscription.id },
      });

      if (existingCount >= 5) {
        return res
          .status(400)
          .json({ error: 'You can save up to 5 task templates per subscription.' });
      }

      const parseResult = taskTemplateSchema.parse(req.body);

      const template = await SubscriptionTaskTemplate.create({
        subscriptionId: subscription.id,
        heading: parseResult.heading,
        instructions: compressString(parseResult.instructions),
        isDefault: false,
      });

      res.status(201).json({
        id: template.id,
        heading: template.heading,
        instructions: decompressString(template.instructions) ?? '',
        isDefault: template.isDefault,
      });
    } catch (err) {
      logger.error('Error creating task template.', { error: err });
      if (err instanceof zod.ZodError) {
        return res.status(400).json({ error: 'Invalid template data.' });
      }
      res.status(500).json({ error: 'Failed to create task template.' });
    }
  });

  router.put('/templates/:id', authMiddleware, async (req, res) => {
    const { logger, subscription } = res.locals;
    const { id } = req.params;

    try {
      const parseResult = taskTemplateSchema.parse(req.body);

      const template = await SubscriptionTaskTemplate.findOne({
        where: { id, subscriptionId: subscription.id },
      });

      if (!template) {
        return res.status(404).json({ error: 'Template not found.' });
      }

      template.heading = parseResult.heading;
      template.instructions = compressString(parseResult.instructions);
      await template.save();

      res.json({
        id: template.id,
        heading: template.heading,
        instructions: decompressString(template.instructions) ?? '',
        isDefault: template.isDefault,
      });
    } catch (err) {
      logger.error('Error updating task template.', { error: err });
      if (err instanceof zod.ZodError) {
        return res.status(400).json({ error: 'Invalid template data.' });
      }
      res.status(500).json({ error: 'Failed to update task template.' });
    }
  });

  router.delete('/templates/:id', authMiddleware, async (req, res) => {
    const { logger, subscription } = res.locals;
    const { id } = req.params;

    try {
      const template = await SubscriptionTaskTemplate.findOne({
        where: { id, subscriptionId: subscription.id },
      });

      if (!template) {
        return res.status(404).json({ error: 'Template not found.' });
      }

      await template.destroy();

      res.status(204).send();
    } catch (err) {
      logger.error('Error deleting task template.', { error: err });
      res.status(500).json({ error: 'Failed to delete task template.' });
    }
  });

  router.post('/templates/:id/set-default', authMiddleware, async (req, res) => {
    const { logger, subscription } = res.locals;
    const { id } = req.params;

    try {
      const template = await SubscriptionTaskTemplate.findOne({
        where: { id, subscriptionId: subscription.id },
      });

      if (!template) {
        return res.status(404).json({ error: 'Template not found.' });
      }

      if (template.isDefault) {
        // If the template is already the default, just return it in the
        // same shape as other successful responses so clients can
        // consistently decode a template DTO.
        return res.json({
          id: template.id,
          heading: template.heading,
          instructions: decompressString(template.instructions) ?? '',
          isDefault: template.isDefault,
        });
      }

      // Clear previous default(s)
      await SubscriptionTaskTemplate.update(
        { isDefault: false },
        { where: { subscriptionId: subscription.id, isDefault: true } },
      );

      template.isDefault = true;
      await template.save();

      res.json({
        id: template.id,
        heading: template.heading,
        instructions: decompressString(template.instructions) ?? '',
        isDefault: template.isDefault,
      });
    } catch (err) {
      logger.error('Error setting default task template.', { error: err });
      res.status(500).json({ error: 'Failed to set default task template.' });
    }
  });

  return router;
}
