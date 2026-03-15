"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.taskInstructionRouter = taskInstructionRouter;
const express_1 = __importDefault(require("express"));
const authMiddleware_1 = require("./authMiddleware");
const zod_1 = __importDefault(require("zod"));
const compression_1 = require("./compression");
const subscriptionTaskTemplate_1 = require("./models/subscriptionTaskTemplate");
const taskTemplateSchema = zod_1.default.object({
    heading: zod_1.default.string().min(1).max(200),
    instructions: zod_1.default.string(),
});
function taskInstructionRouter() {
    const router = express_1.default.Router();
    // Task template CRUD endpoints
    router.get('/templates', authMiddleware_1.authMiddleware, async (req, res) => {
        const { logger, subscription } = res.locals;
        try {
            const templates = await subscriptionTaskTemplate_1.SubscriptionTaskTemplate.findAll({
                where: { subscriptionId: subscription.id },
                order: [['createdAt', 'ASC']],
            });
            const result = templates.map((tpl) => ({
                id: tpl.id,
                heading: tpl.heading,
                instructions: (0, compression_1.decompressString)(tpl.instructions) ?? '',
                isDefault: tpl.isDefault,
            }));
            res.json({ templates: result });
        }
        catch (err) {
            logger.error('Error retrieving task templates.', { error: err });
            res.status(500).json({ error: 'Failed to retrieve task templates.' });
        }
    });
    router.post('/templates', authMiddleware_1.authMiddleware, async (req, res) => {
        const { logger, subscription } = res.locals;
        try {
            const existingCount = await subscriptionTaskTemplate_1.SubscriptionTaskTemplate.count({
                where: { subscriptionId: subscription.id },
            });
            if (existingCount >= 5) {
                return res
                    .status(400)
                    .json({ error: 'You can save up to 5 task templates per subscription.' });
            }
            const parseResult = taskTemplateSchema.parse(req.body);
            const template = await subscriptionTaskTemplate_1.SubscriptionTaskTemplate.create({
                subscriptionId: subscription.id,
                heading: parseResult.heading,
                instructions: (0, compression_1.compressString)(parseResult.instructions),
                isDefault: false,
            });
            res.status(201).json({
                id: template.id,
                heading: template.heading,
                instructions: (0, compression_1.decompressString)(template.instructions) ?? '',
                isDefault: template.isDefault,
            });
        }
        catch (err) {
            logger.error('Error creating task template.', { error: err });
            if (err instanceof zod_1.default.ZodError) {
                return res.status(400).json({ error: 'Invalid template data.' });
            }
            res.status(500).json({ error: 'Failed to create task template.' });
        }
    });
    router.put('/templates/:id', authMiddleware_1.authMiddleware, async (req, res) => {
        const { logger, subscription } = res.locals;
        const { id } = req.params;
        try {
            const parseResult = taskTemplateSchema.parse(req.body);
            const template = await subscriptionTaskTemplate_1.SubscriptionTaskTemplate.findOne({
                where: { id, subscriptionId: subscription.id },
            });
            if (!template) {
                return res.status(404).json({ error: 'Template not found.' });
            }
            template.heading = parseResult.heading;
            template.instructions = (0, compression_1.compressString)(parseResult.instructions);
            await template.save();
            res.json({
                id: template.id,
                heading: template.heading,
                instructions: (0, compression_1.decompressString)(template.instructions) ?? '',
                isDefault: template.isDefault,
            });
        }
        catch (err) {
            logger.error('Error updating task template.', { error: err });
            if (err instanceof zod_1.default.ZodError) {
                return res.status(400).json({ error: 'Invalid template data.' });
            }
            res.status(500).json({ error: 'Failed to update task template.' });
        }
    });
    router.delete('/templates/:id', authMiddleware_1.authMiddleware, async (req, res) => {
        const { logger, subscription } = res.locals;
        const { id } = req.params;
        try {
            const template = await subscriptionTaskTemplate_1.SubscriptionTaskTemplate.findOne({
                where: { id, subscriptionId: subscription.id },
            });
            if (!template) {
                return res.status(404).json({ error: 'Template not found.' });
            }
            await template.destroy();
            res.status(204).send();
        }
        catch (err) {
            logger.error('Error deleting task template.', { error: err });
            res.status(500).json({ error: 'Failed to delete task template.' });
        }
    });
    router.post('/templates/:id/set-default', authMiddleware_1.authMiddleware, async (req, res) => {
        const { logger, subscription } = res.locals;
        const { id } = req.params;
        try {
            const template = await subscriptionTaskTemplate_1.SubscriptionTaskTemplate.findOne({
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
                    instructions: (0, compression_1.decompressString)(template.instructions) ?? '',
                    isDefault: template.isDefault,
                });
            }
            // Clear previous default(s)
            await subscriptionTaskTemplate_1.SubscriptionTaskTemplate.update({ isDefault: false }, { where: { subscriptionId: subscription.id, isDefault: true } });
            template.isDefault = true;
            await template.save();
            res.json({
                id: template.id,
                heading: template.heading,
                instructions: (0, compression_1.decompressString)(template.instructions) ?? '',
                isDefault: template.isDefault,
            });
        }
        catch (err) {
            logger.error('Error setting default task template.', { error: err });
            res.status(500).json({ error: 'Failed to set default task template.' });
        }
    });
    return router;
}
