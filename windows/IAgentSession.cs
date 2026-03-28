namespace OmniKey.Windows
{
    /// <summary>
    /// Abstraction over AgentThinkingForm / MainForm agent panel.
    /// AgentRunner calls these methods during a live session.
    /// </summary>
    internal interface IAgentSession
    {
        void SetInitialRequest(string text);
        void SetRunning(bool running);
        void AppendAgentMessage(string text);
        void AppendWebCall(string text);
        void AppendTerminalOutput(string text);
    }
}
