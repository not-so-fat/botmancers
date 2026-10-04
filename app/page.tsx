'use client';

import { useState, useEffect, useRef } from 'react';

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
  const [hasRunningCommand, setHasRunningCommand] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    loadBots();
    loadGroups();
  }, []);

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
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

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
    
    const cmdRes = await fetch(`/api/conversations/${activeConversation.id}/running-command`);
    const cmdData = await cmdRes.json();
    setHasRunningCommand(cmdData.hasRunningCommand || false);
  };

  const stopCommand = async () => {
    if (!activeConversation) return;
    await fetch(`/api/conversations/${activeConversation.id}/stop-command`, {
      method: 'POST',
    });
    setHasRunningCommand(false);
    loadMessages();
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

  return (
    <div className="flex h-screen bg-gray-50">
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
              onClick={() => setShowGroupModal(true)}
              className="w-full py-2 px-3 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700"
            >
              + New Group
            </button>
          </div>
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

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {messages.map(msg => (
                <div
                  key={msg.id}
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
                    <div className="whitespace-pre-wrap">{msg.content}</div>
                  </div>
                </div>
              ))}
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
                {hasRunningCommand ? (
                  <button
                    onClick={stopCommand}
                    className="px-6 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
                  >
                    Stop
                  </button>
                ) : (
                  <button
                    onClick={sendMessage}
                    className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                  >
                    Send
                  </button>
                )}
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
