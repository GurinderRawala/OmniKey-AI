using System;
using OmniKey.Windows.Skills;
using OmniKey.Windows.ViewModels;
using Xunit;

namespace OmniKey.Windows.Tests
{
    /// <summary>
    /// ChatViewModel's fast path rebuilds rows by id using these helpers.
    /// A steering bubble can sit below the assistant bubble that is still
    /// streaming, so "last row" is not the streaming row.
    /// </summary>
    public class ChatRowRefreshTests
    {
        private static ChatRowSnapshot Row(Guid id, bool streaming = false, int blocks = 0,
            SteeringBubbleState state = SteeringBubbleState.Pending, string? reason = null, bool unconfirmed = false) =>
            new(id, streaming, blocks, state, reason, unconfirmed);

        [Fact]
        public void StreamingFollowsTheLedgerTargetNotTheLastRow()
        {
            var assistant = Guid.NewGuid();
            var trailingSteering = Guid.NewGuid();

            Assert.True(ChatRowRefresh.IsStreaming(true, assistant, assistant, isAssistant: true));
            Assert.False(ChatRowRefresh.IsStreaming(true, assistant, trailingSteering, isAssistant: false));
            Assert.False(ChatRowRefresh.IsStreaming(false, assistant, assistant, isAssistant: true));
            Assert.False(ChatRowRefresh.IsStreaming(true, null, assistant, isAssistant: true));
            Assert.False(ChatRowRefresh.IsStreaming(true, Guid.NewGuid(), assistant, isAssistant: true));
        }

        [Fact]
        public void EarlierAssistantRowIsRebuiltWhenItsBlocksOrStreamingChange()
        {
            var id = Guid.NewGuid();
            // Streaming target above a trailing steering bubble keeps refreshing.
            Assert.True(ChatRowRefresh.NeedsRebuild(Row(id, streaming: true, blocks: 2), Row(id, streaming: true, blocks: 2)));
            // Output moved to a continuation: the old bubble stops streaming.
            Assert.True(ChatRowRefresh.NeedsRebuild(Row(id, streaming: true, blocks: 3), Row(id, streaming: false, blocks: 3)));
            // Blocks were appended to a non-last, non-streaming row.
            Assert.True(ChatRowRefresh.NeedsRebuild(Row(id, blocks: 3), Row(id, blocks: 4)));
            // Nothing changed: keep realized visuals.
            Assert.False(ChatRowRefresh.NeedsRebuild(Row(id, blocks: 3), Row(id, blocks: 3)));
        }

        [Fact]
        public void SteeringStatusChangesRebuildTheBubble()
        {
            var id = Guid.NewGuid();
            var pending = Row(id);
            Assert.True(ChatRowRefresh.NeedsRebuild(pending, Row(id, state: SteeringBubbleState.Received)));
            Assert.True(ChatRowRefresh.NeedsRebuild(pending, Row(id, unconfirmed: true)));
            Assert.True(ChatRowRefresh.NeedsRebuild(pending, Row(id, state: SteeringBubbleState.Applied)));
            Assert.True(ChatRowRefresh.NeedsRebuild(pending, Row(id, state: SteeringBubbleState.Failed, reason: "x")));
            Assert.False(ChatRowRefresh.NeedsRebuild(pending, Row(id)));
        }
    }
}
