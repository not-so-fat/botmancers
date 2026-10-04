'use client';

import { useState, useEffect, useRef } from 'react';

function parseRun(content: string): { state: 'running' | 'done' | 'stopped'; output?: string; html?: string } | null {
  const match = content.match(/^\s*\[run\]\s*([\s\S]*)$/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (parsed?.state === 'running' || parsed?.state === 'stopped') {
      return {
        state: parsed.state,
        html: typeof parsed.html === 'string' ? parsed.html : undefined
      };
    }
    if (parsed?.state === 'done' && typeof parsed.output === 'string') {
      return {
        state: 'done',
        output: parsed.output,
        html: typeof parsed.html === 'string' ? parsed.html : undefined
      };
    }
  } catch {
    // not valid JSON
  }
  return null;
}

function runLine(run: { state: 'running' | 'done' | 'stopped'; output?: string }): string {
  if (run.state === 'done') return run.output ?? '';
  if (run.state === 'stopped') return 'The command was stopped.';
  return 'The command is running';
}

interface Bot {
  id: string;
  name: string;
  title: string;
  description: string;
  avatar?: string;
}

interface Group {
  id: string;
  name: string;
  members: Bot[];
}

interface Message {
  id: string;
  sender_type: 'user' | 'bot';
  sender_id?: string;
  sender_name?: string;
  content: string;
  created_at: number;
}

interface Conversation {
  id: string;
  type: 'bot' | 'group';
  details: Bot | Group;
}

export default function Home() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [showBotModal, setShowBotModal] = useState(false);
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [importError, setImportError] = useState<string | null>(null);
  const [showComputerPreview, setShowComputerPreview] = useState(false);
  const [previewPageContent, setPreviewPageContent] = useState<string | null>(null);
  const [previewRunningMessage, setPreviewRunningMessage] = useState<Message | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const runningMessageRef = useRef<HTMLDivElement>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    loadBots();
    loadGroups();
    
    const urlParams = new URLSearchParams(window.location.search);
    const importedBotId = urlParams.get('imported');
    
    if (importedBotId) {
      handleImportReturn(importedBotId);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);
  
  const handleImportReturn = async (botId: string) => {
    await loadBots();
    
    const bot = bots.find(b => b.id === botId);
    if (!bot) {
      const refreshedBots = await fetch('/api/bots').then(r => r.json());
      const foundBot = refreshedBots.find((b: Bot) => b.id === botId);
      
      if (foundBot) {
        setBots(refreshedBots);
        openConversation('bot', botId);
      } else {
        setImportError('Imported bot not found. The bot may not have been created successfully.');
      }
    } else {
      openConversation('bot', botId);
    }
  };

  useEffect(() => {
    if (activeConversation) {
      loadMessages();
      
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
      
      pollIntervalRef.current = setInterval(loadMessages, 2000);
      
      return () => {
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
        }
      };
    }
  }, [activeConversation]);

  useEffect(() => {
    if (showComputerPreview && previewRunningMessage && runningMessageRef.current && messagesContainerRef.current) {
      const attemptScroll = () => {
        const messageElement = runningMessageRef.current;
        const container = messagesContainerRef.current;
        const darkBand = document.getElementById('computer-preview-dark-band');
        const desktop = document.getElementById('computer-preview-desktop');
        if (!messageElement || !container || !darkBand || !desktop) return;
        
        const messageRect = messageElement.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const darkBandRect = darkBand.getBoundingClientRect();
        
        const messageHeight = messageRect.height;
        darkBand.style.height = `${messageHeight}px`;
        
        const desktopStart = 44 + messageHeight;
        desktop.style.top = `${desktopStart}px`;
        
        const targetPosition = darkBandRect.top - containerRect.top;
        const currentMessagePosition = messageRect.top - containerRect.top;
        const scrollAdjustment = currentMessagePosition - targetPosition;
        
        container.scrollTop += scrollAdjustment;
      };
      
      const timeoutId = setTimeout(attemptScroll, 100);
      return () => clearTimeout(timeoutId);
    } else if (!showComputerPreview && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, showComputerPreview, previewRunningMessage]);

  useEffect(() => {
    if (!activeConversation || activeConversation.type !== 'bot') {
      setShowComputerPreview(false);
      setPreviewPageContent(null);
      setPreviewRunningMessage(null);
      return;
    }

    const bot = activeConversation.details as Bot;
    if (bot.name.toLowerCase() !== 'chief-of-staff') {
      setShowComputerPreview(false);
      setPreviewPageContent(null);
      setPreviewRunningMessage(null);
      return;
    }

    setShowComputerPreview(true);

    const lastBotMessage = [...messages].reverse().find(m => {
      if (m.sender_type !== 'bot') return false;
      return parseRun(m.content) !== null;
    });

    if (lastBotMessage) {
      const run = parseRun(lastBotMessage.content);
      setPreviewRunningMessage(lastBotMessage);
      
      if (run && run.state === 'stopped') {
        setPreviewPageContent(null);
      } else if (run && run.html) {
        setPreviewPageContent(run.html);
      } else {
        setPreviewPageContent(null);
      }
    } else {
      setPreviewRunningMessage(null);
      setPreviewPageContent(null);
    }
  }, [messages, activeConversation]);

  const loadBots = async () => {
    const res = await fetch('/api/bots');
    const data = await res.json();
    setBots(data);
  };

  const loadGroups = async () => {
    const res = await fetch('/api/groups');
    const data = await res.json();
    setGroups(data);
  };

  const loadMessages = async () => {
    if (!activeConversation) return;
    const res = await fetch(`/api/conversations/${activeConversation.id}/messages`);
    const data = await res.json();
    setMessages(data);
  };

  const openConversation = async (type: 'bot' | 'group', id: string) => {
    if (type === 'bot') {
      const bot = bots.find(b => b.id === id);
      if (!bot) return;
      
      const convRes = await fetch(`/api/conversations?botId=${id}`);
      const conv = await convRes.json();
      
      setActiveConversation({
        id: conv.id,
        type: 'bot',
        details: bot,
      });
    } else {
      const group = groups.find(g => g.id === id);
      if (!group) return;
      
      const convRes = await fetch(`/api/conversations?groupId=${id}`);
      const conv = await convRes.json();
      
      setActiveConversation({
        id: conv.id,
        type: 'group',
        details: group,
      });
    }
    
    setShowSidebar(false);
  };

  const sendMessage = async () => {
    if (!inputMessage.trim() || !activeConversation) return;

    await fetch(`/api/conversations/${activeConversation.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: inputMessage }),
    });

    setInputMessage('');
    loadMessages();
  };

  const stopRun = async (messageId: string) => {
    await fetch(`/api/conversations/${activeConversation?.id}/messages/${messageId}/stop`, {
      method: 'POST',
    });
    loadMessages();
  };
  
  const handleImportFromMarketplace = async () => {
    setImportError(null);
    
    try {
      const statusResponse = await fetch('/api/marketplace-handoff/status');
      const { configured } = await statusResponse.json();
      
      if (!configured) {
        setImportError('CLONE_MARKET_URL is not configured. Please contact your administrator.');
        return;
      }
      
      const returnPath = window.location.origin + window.location.pathname;
      const handoffUrl = `/api/marketplace-handoff?return=${encodeURIComponent(returnPath)}`;
      
      window.location.href = handoffUrl;
    } catch (error) {
      setImportError('Failed to initiate import. Please try again.');
    }
  };

  return (
    <div className="relative flex h-screen bg-gray-50">
      <div className={`${showSidebar ? 'w-full sm:w-80' : 'hidden'} sm:block sm:${showSidebar ? 'w-80' : 'w-0'} bg-white border-r transition-all duration-200 overflow-hidden`}>
        <div className="p-4 border-b">
          <h1 className="text-xl font-bold text-gray-800">Botmancers</h1>
          <div className="mt-3 space-y-2">
            <button
              onClick={() => setShowBotModal(true)}
              className="w-full py-2 px-3 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"
            >
              + New Bot
            </button>
            <button
              onClick={handleImportFromMarketplace}
              className="w-full py-2 px-3 border border-blue-600 text-blue-600 rounded-lg text-sm hover:bg-blue-50"
            >
              Import from Grok Marketplace
            </button>
            <button
              onClick={() => setShowGroupModal(true)}
              className="w-full py-2 px-3 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700"
            >
              + New Group
            </button>
          </div>
          {importError && (
            <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {importError}
              <button
                onClick={() => setImportError(null)}
                className="ml-2 underline hover:no-underline"
              >
                Dismiss
              </button>
            </div>
          )}
        </div>
        
        <div className="overflow-y-auto" style={{ height: 'calc(100vh - 140px)' }}>
          {bots.length > 0 && (
            <div className="p-4">
              <h2 className="text-xs font-semibold text-gray-500 uppercase mb-2">Bots</h2>
              {bots.map(bot => (
                <button
                  key={bot.id}
                  onClick={() => openConversation('bot', bot.id)}
                  className="w-full text-left p-3 rounded-lg hover:bg-gray-100 mb-1"
                >
                  <div className="font-medium text-gray-800">{bot.name}</div>
                  <div className="text-xs text-gray-500">{bot.title}</div>
                </button>
              ))}
            </div>
          )}
          
          {groups.length > 0 && (
            <div className="p-4">
              <h2 className="text-xs font-semibold text-gray-500 uppercase mb-2">Groups</h2>
              {groups.map(group => (
                <button
                  key={group.id}
                  onClick={() => openConversation('group', group.id)}
                  className="w-full text-left p-3 rounded-lg hover:bg-gray-100 mb-1"
                >
                  <div className="font-medium text-gray-800">{group.name}</div>
                  <div className="text-xs text-gray-500">
                    {group.members.map(m => m.name).join(', ')}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 flex flex-col">
        {activeConversation ? (
          <>
            <div className="p-4 border-b bg-white flex items-center">
              <button
                onClick={() => setShowSidebar(!showSidebar)}
                className="sm:hidden mr-3 p-2 hover:bg-gray-100 rounded"
              >
                ☰
              </button>
              <div>
                <h2 className="font-semibold text-gray-800">
                  {activeConversation.type === 'bot'
                    ? (activeConversation.details as Bot).name
                    : (activeConversation.details as Group).name}
                </h2>
                <p className="text-xs text-gray-500">
                  {activeConversation.type === 'bot'
                    ? (activeConversation.details as Bot).title
                    : `${(activeConversation.details as Group).members.length} members`}
                </p>
              </div>
            </div>

            <div ref={messagesContainerRef} className="flex-1 overflow-y-auto p-4 space-y-3">
              {messages.map(msg => {
                const run = msg.sender_type === 'bot' ? parseRun(msg.content) : null;
                const displayContent = run ? runLine(run) : msg.content;
                const isRunningMessage = previewRunningMessage && msg.id === previewRunningMessage.id;
                
                return (
                  <div
                    key={msg.id}
                    ref={isRunningMessage ? runningMessageRef : null}
                    className={`flex ${msg.sender_type === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[80%] rounded-lg p-3 ${
                        msg.sender_type === 'user'
                          ? 'bg-blue-600 text-white'
                          : 'bg-white border text-gray-800'
                      }`}
                    >
                      {msg.sender_type === 'bot' && msg.sender_name && (
                        <div className="text-xs font-semibold text-gray-500 mb-1">
                          {msg.sender_name}
                        </div>
                      )}
                      <div className="whitespace-pre-wrap">{displayContent}</div>
                      {run && run.state === 'running' && (
                        <button
                          onClick={() => stopRun(msg.id)}
                          className="mt-2 px-3 py-1 text-sm bg-red-600 text-white rounded hover:bg-red-700"
                        >
                          Stop
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              {showComputerPreview && previewRunningMessage && (
                <div style={{ height: '200px' }} />
              )}
              <div ref={messagesEndRef} />
            </div>

            <div className="p-4 border-t bg-white">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={inputMessage}
                  onChange={e => setInputMessage(e.target.value)}
                  onKeyPress={e => e.key === 'Enter' && sendMessage()}
                  placeholder="Type a message..."
                  className="flex-1 px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
                <button
                  onClick={sendMessage}
                  className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                >
                  Send
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-500">
            <div className="text-center">
              <button
                onClick={() => setShowSidebar(true)}
                className="sm:hidden mb-4 px-4 py-2 bg-blue-600 text-white rounded-lg"
              >
                Show Sidebar
              </button>
              <p>Select a bot or group to start chatting</p>
            </div>
          </div>
        )}
      </div>

      {showBotModal && (
        <BotModal
          onClose={() => setShowBotModal(false)}
          onCreated={() => {
            loadBots();
            setShowBotModal(false);
          }}
        />
      )}

      {showGroupModal && (
        <GroupModal
          bots={bots}
          onClose={() => setShowGroupModal(false)}
          onCreated={() => {
            loadGroups();
            setShowGroupModal(false);
          }}
        />
      )}

      {showComputerPreview && (
        <ComputerPreview pageContent={previewPageContent} />
      )}
    </div>
  );
}

interface ComputerPreviewProps {
  pageContent: string | null;
}

function ComputerPreview({ pageContent }: ComputerPreviewProps) {
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center p-4 pointer-events-none">
      <div className="relative w-full max-w-5xl h-full max-h-[90vh] rounded-lg shadow-2xl overflow-hidden">
        <div className="absolute top-0 left-0 right-0 h-11 bg-gray-800 flex items-center justify-between px-4 pointer-events-none">
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-full bg-red-500"></div>
            <div className="w-3 h-3 rounded-full bg-yellow-500"></div>
            <div className="w-3 h-3 rounded-full bg-green-500"></div>
          </div>
          <div className="flex items-center gap-2 text-gray-300 text-sm">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="9" />
            </svg>
            <span>Teach a task</span>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M15 3h6m0 0v6m0-6l-7 7M9 21H3m0 0v-6m0 6l7-7" />
            </svg>
          </div>
          <div className="w-16"></div>
        </div>
        
        <div id="computer-preview-dark-band" className="absolute top-11 left-0 right-0 bg-gray-900 bg-opacity-30 pointer-events-none"></div>
        
        <div 
          id="computer-preview-desktop"
          className="absolute left-0 right-0 bottom-0 overflow-auto pointer-events-none"
          style={{
            top: '156px',
            backgroundImage: 'url(/wallpaper_1c49.png)',
            backgroundSize: 'cover',
            backgroundPosition: 'center'
          }}
        >
          {pageContent ? (
            <iframe
              srcDoc={pageContent}
              className="w-full h-full border-0 pointer-events-none"
              sandbox="allow-same-origin"
              title="Preview"
            />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-end pb-6">
              <div className="flex gap-3">
                <div className="w-16 h-16 rounded-xl overflow-hidden shadow-lg">
                  <img src="/dock-chrome_c5c1.png" alt="Chrome" className="w-full h-full object-contain" />
                </div>
                <div className="w-16 h-16 rounded-xl overflow-hidden shadow-lg">
                  <img src="/dock-gray_6226.png" alt="App" className="w-full h-full object-contain" />
                </div>
                <div className="w-16 h-16 rounded-xl overflow-hidden shadow-lg">
                  <img src="/dock-terminal_166d.png" alt="Terminal" className="w-full h-full object-contain" />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function BotModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await fetch('/api/bots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, title, description }),
    });
    onCreated();
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg max-w-md w-full p-6">
        <h2 className="text-xl font-bold mb-4">Create New Bot</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
              rows={4}
              required
            />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 border rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function GroupModal({
  bots,
  onClose,
  onCreated,
}: {
  bots: Bot[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [selectedBotIds, setSelectedBotIds] = useState<string[]>([]);

  const toggleBot = (botId: string) => {
    setSelectedBotIds(prev =>
      prev.includes(botId) ? prev.filter(id => id !== botId) : [...prev, botId]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await fetch('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, botIds: selectedBotIds }),
    });
    onCreated();
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg max-w-md w-full p-6">
        <h2 className="text-xl font-bold mb-4">Create New Group</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Group Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Select Bots</label>
            <div className="border rounded-lg max-h-48 overflow-y-auto">
              {bots.map(bot => (
                <label
                  key={bot.id}
                  className="flex items-center p-3 hover:bg-gray-50 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selectedBotIds.includes(bot.id)}
                    onChange={() => toggleBot(bot.id)}
                    className="mr-3"
                  />
                  <div>
                    <div className="font-medium">{bot.name}</div>
                    <div className="text-xs text-gray-500">{bot.title}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 border rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={selectedBotIds.length === 0}
              className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
            >
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
