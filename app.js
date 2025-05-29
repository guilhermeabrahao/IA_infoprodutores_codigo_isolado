import express from "express";
import bodyParser from "body-parser";
import https from "https";
import OpenAI from "openai";
import redis from 'redis';
import moment from 'moment-timezone';
import axios from "axios";
import fs from "fs";
import path from "path";
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import pdf from 'pdf-parse';
import rateLimit from 'express-rate-limit';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

// Função para enviar indicador de "digitando" no WhatsApp
async function sendTypingOn(whatsappBusinessPhoneNumberId, accessToken, userMessageId) {
  const apiVersion = process.env.GRAPH_API_VERSION || "v22.0";
  const apiUrl = `https://graph.facebook.com/${apiVersion}/${whatsappBusinessPhoneNumberId}/messages`;
  const data = {
    messaging_product: "whatsapp",
    status: "read",
    message_id: userMessageId,
    typing_indicator: {
      type: "text"
    }
  };

  try {
    console.log(`Sending typing_on (and marking as read) to: ${apiUrl} for message_id: ${userMessageId}`);
    console.log(`With data: ${JSON.stringify(data)}`);
    console.log(`Using token: ${accessToken ? accessToken.substring(0, 10) + '...' : 'undefined'}`);

    const response = await axios.post(apiUrl, data, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    console.log(`Typing indicator 'typing_on' (and marked as read) sent for message_id ${userMessageId}. Response status: ${response.status}, data: ${JSON.stringify(response.data)}`);
  } catch (error) {
    if (error.response) {
      console.error(`Error sending typing_on indicator for message_id ${userMessageId}. Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`);
    } else {
      console.error(`Error sending typing_on indicator for message_id ${userMessageId}: ${error.message}`);
    }
  }
}

// Mantém o "digitando" ativo até sinal de parada
async function keepTypingIndicatorActive(whatsappBusinessPhoneNumberId, accessToken, messageId, stopSignal) {
  while (!stopSignal.stopped) {
    await sendTypingOn(whatsappBusinessPhoneNumberId, accessToken, messageId);
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}

// Função para enviar reação (emoji) para uma mensagem
async function sendReactionToMessage(whatsappBusinessPhoneNumberId, accessToken, userPhoneNumber, messageId, emoji) {
  const apiVersion = process.env.GRAPH_API_VERSION || "v22.0";
  const apiUrl = `https://graph.facebook.com/${apiVersion}/${whatsappBusinessPhoneNumberId}/messages`;
  const data = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: userPhoneNumber,
    type: "reaction",
    reaction: {
      message_id: messageId,
      emoji: emoji
    }
  };

  try {
    console.log(`Sending reaction to: ${apiUrl} for message_id: ${messageId} to user: ${userPhoneNumber}`);
    console.log(`With data: ${JSON.stringify(data)}`);
    console.log(`Using token: ${accessToken ? accessToken.substring(0, 10) + '...' : 'undefined'}`);

    const response = await axios.post(apiUrl, data, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    console.log(`Reaction sent for message_id ${messageId}. Response status: ${response.status}, data: ${JSON.stringify(response.data)}`);
  } catch (error) {
    if (error.response) {
      console.error(`Error sending reaction for message_id ${messageId}. Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`);
    } else {
      console.error(`Error sending reaction for message_id ${messageId}: ${error.message}`);
    }
    // Não relança, pois reação é ação secundária
  }
}

function getCurrentDate() {
  return moment().tz("America/Sao_Paulo").format('DD/MM/YYYY');
}

const app = express();
app.use(bodyParser.json());
app.set('trust proxy', 1);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: "Muitas solicitações criadas a partir deste dispositivo, por favor, tente novamente após 15 minutos"
});

app.use(limiter);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const redisClient = redis.createClient({
  url: `redis://default:${process.env.REDIS_PASSWORD}@${process.env.REDIS_URL}`
});

redisClient.connect().then(() => {
  console.log("Redis client connected");
}).catch((err) => {
  console.error("Redis connection error:", err);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.listen(process.env.PORT || 1337, () => console.log("Webhook is listening"));

function formatMessageWithDate(message, timestamp, profileName) {
  const messageDateTime = moment(timestamp * 1000).tz("America/Sao_Paulo").format('DD/MM/YYYY HH:mm:ss');
  return `${messageDateTime} - ${profileName}: ${message}`;
}

// Função para armazenar mensagens no Redis
async function storeMessageInConversation(phoneNumber, threadId, messageData) {
  const key = `conversation:${phoneNumber}:${threadId}`;
  await redisClient.rPush(key, JSON.stringify(messageData));
}

// Mapa para controlar operações simultâneas em threads
let runningOperations = {};

// Map para armazenar mensagens temporariamente
const messageBuffers = new Map();
const bufferTimeouts = new Map();

async function waitUntilNoActiveRun(threadId, maxRetries = 10, delay = 3000) {
  let retries = 0;
  let runActive = await isRunActive(threadId);

  while (runActive && retries < maxRetries) {
    console.log(`Run ainda ativo para o thread ${threadId}. Aguardando...`);
    await new Promise(resolve => setTimeout(resolve, delay));
    runActive = await isRunActive(threadId);
    retries++;
  }

  if (runActive) {
    console.warn(`Run ainda ativo após ${retries} tentativas para o thread ${threadId}.`);
    throw new Error(`Não foi possível adicionar mensagens ao thread ${threadId} devido a um run ativo.`);
  }

  console.log(`Nenhum run ativo encontrado para o thread ${threadId}. Continuando...`);
}

// Função para adicionar uma mensagem ao thread com retry e controle de concorrência
async function addMessageWithRetry(threadId, message, maxRetries = 3, delay = 3000) {
  if (runningOperations[threadId]) {
    console.log(`Operação já em execução para o thread ${threadId}, aguardando...`);
    await runningOperations[threadId];
  }

  let resolveOperation;
  runningOperations[threadId] = new Promise(resolve => {
    resolveOperation = resolve;
  });

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await waitUntilNoActiveRun(threadId);
      await openai.beta.threads.messages.create(threadId, {
        role: "user",
        content: message
      });
      console.log(`Mensagem adicionada com sucesso ao thread ${threadId} na tentativa ${attempt}.`);
      resolveOperation();
      delete runningOperations[threadId];
      return;
    } catch (error) {
      console.error(`Erro ao adicionar mensagem ao thread ${threadId} na tentativa ${attempt}: ${error.message}`);
      if (attempt < maxRetries) {
        console.log(`Tentando novamente em ${delay / 1000} segundos...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        resolveOperation();
        delete runningOperations[threadId];
        throw new Error(`Falha ao adicionar mensagem ao thread ${threadId} após ${maxRetries} tentativas.`);
      }
    }
  }
}

function normalizePhoneNumber(phone) {
  if (!phone) return '';

  let normalizedPhone = phone.replace(/\D/g, '');

  if (normalizedPhone.startsWith('55')) {
    normalizedPhone = normalizedPhone.slice(2);
    if (normalizedPhone.length === 10) {
      const ddd = normalizedPhone.slice(0, 2);
      const restOfNumber = normalizedPhone.slice(2);
      normalizedPhone = `${ddd}9${restOfNumber}`;
    }
  }

  return normalizedPhone;
}

function checkMessageSize(req, res, next) {
  const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (message && message.text && message.text.body && message.text.body.length > 1000) {
    return res.status(400).send("Mensagem muito longa");
  }
  next();
}

app.use(checkMessageSize);

async function getTokenUsage(threadId) {
  try {
    const runsResponse = await openai.beta.threads.runs.list(threadId);
    let totalTokens = 0;

    for (const run of runsResponse.data) {
      if (run.usage && run.usage.total_tokens) {
        totalTokens += run.usage.total_tokens;
      }
    }

    console.log(`Total de tokens usados no thread ${threadId}: ${totalTokens}`);
    return totalTokens;
  } catch (error) {
    console.error(`Erro ao obter o uso de tokens para o thread ${threadId}:`, error);
    throw error;
  }
}

async function summarizeContext(threadId) {
  try {
    const messagesResponse = await openai.beta.threads.messages.list(threadId);
    const contextMessages = messagesResponse.data.map(msg => ({
      role: msg.role,
      content: msg.content[0].text.value
    }));

    const summaryResponse = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "user", content: "Resuma a conversa de forma objetiva enfatizando os pontos mais importantes." },
        ...contextMessages
      ],
      max_tokens: 4000
    });

    console.log("Resumo do contexto gerado com sucesso.");
    return summaryResponse.choices[0].message.content.trim();
  } catch (error) {
    console.error("Erro ao resumir o contexto:", error);
    throw error;
  }
}

// Função para enviar um contato via WhatsApp
async function sendContactMessage(phone_number_id, whatsapp_token, to) {
  const axios = (await import('axios')).default;
  const apiVersion = process.env.GRAPH_API_VERSION || "v22.0";
  const apiUrl = `https://graph.facebook.com/${apiVersion}/${phone_number_id}/messages`;

  const contactPayload = {
    messaging_product: "whatsapp",
    to: to,
    type: "contacts",
    contacts: [
      {
        name: {
          formatted_name: "Guilherme Nobre",
          first_name: "Guilherme",
          last_name: "Nobre"
        },
        org: {
          company: "Equipe Comercial"
        },
        phones: [
          {
            phone: "+5527996187926",
            type: "Mobile",
            wa_id: "5527996187926"
          }
        ]
      }
    ]
  };

  try {
    const response = await axios.post(apiUrl, contactPayload, {
      headers: {
        'Authorization': `Bearer ${whatsapp_token}`,
        'Content-Type': 'application/json'
      }
    });
    console.log('Contato enviado com sucesso:', response.data);
  } catch (error) {
    if (error.response) {
      console.error('Erro ao enviar contato:', error.response.status, error.response.data);
    } else {
      console.error('Erro ao enviar contato:', error.message);
    }
  }
}

app.post("/webhook", async (req, res) => {
  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value;

    // Se não houver mensagens, é um webhook de status (sent, delivered, read, etc)
    if (!value.messages) {
      return res.sendStatus(200); // Ignora rapidamente
    }

    console.log("Webhook received:", JSON.stringify(req.body, null, 2));
    if (!req.body.object) {
      console.log("Invalid webhook object");
      res.sendStatus(404);
      return;
    }

    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    console.log("Received message:", JSON.stringify(message, null, 2));
    
    const profileName = req.body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile?.name || 'Desconhecido';
    console.log("Nome do perfil do usuário no WhatsApp:", profileName);

    // --- INÍCIO: Interação WhatsApp (reação e digitando) ---
    const whatsappBusinessPhoneNumberId = req.body.entry[0].changes[0].value.metadata.phone_number_id;
    const accessToken = process.env.GRAPH_API_TOKEN;
    const userMessageId = message?.id;
    const userPhoneNumberForReaction = message?.from;
    let shouldReactWithSmile = false;
    if (message && message.text && message.text.body) {
      if (message.text.body.toLowerCase().includes("sim")) {
        shouldReactWithSmile = true;
      }
    }
    // --- FIM: Interação WhatsApp (reação e digitando) ---

    if (message && message.from) {
      const phoneNumber = normalizePhoneNumber(message.from);
      console.log("Normalized phone number:", phoneNumber);

      const existingMessageData = await redisClient.hGetAll(`message:${message.id}`);
      console.log(`Message data in Redis for ID ${message.id}:`, existingMessageData);

      if (existingMessageData && existingMessageData.timestamp && existingMessageData.timestamp === String(message.timestamp)) {
        console.log("Mensagem duplicada ignorada.");
        res.sendStatus(200);
      } else {
        // Verificar se já existe um threadId para este número de telefone
        let threadId = await redisClient.get(`threadId:${phoneNumber}`);

        // Se não houver threadId, criar um novo thread
        if (!threadId) {
          console.log(`Nenhum threadId encontrado para o número ${phoneNumber}, criando um novo thread...`);
          const greeting = getTimeBasedGreeting();
          const formattedMessage = formatMessageWithDate(`${greeting} ${message.text ? message.text.body : ''}`, message.timestamp, profileName);

          const thread = await openai.beta.threads.create({
            messages: [{ role: "user", content: formattedMessage }],
            metadata: { phoneNumber: phoneNumber }
          });

          threadId = thread.id;
          await redisClient.set(`threadId:${phoneNumber}`, threadId);
          console.log(`Novo thread ID ${threadId} criado e armazenado para ${phoneNumber}`);
        }

        // Agora que o threadId está garantido, podemos salvar a mensagem no Redis
        const messageData = {
          id: message.id ? message.id.toString() : '', 
          timestamp: message.timestamp ? message.timestamp.toString() : '', 
          phoneNumber: phoneNumber ? phoneNumber.toString() : '', 
          content: message.text && message.text.body ? message.text.body : '', 
          assistantId: process.env.ASSISTANT_ID || '', 
          aiPhoneNumber: process.env.AI_NUMBER || '', 
          threadId: threadId ? threadId.toString() : '', 
          createdAt: Date.now().toString(),
          localTime: moment().tz("America/Sao_Paulo").format('HH:mm:ss'),  // Horário local
          location: message.location ? { lat: message.location.latitude, long: message.location.longitude } : null,  // Geolocalização
          type: message.type ? message.type : 'text',  // Tipo de mensagem
          status: message.status ? message.status : 'unknown',  // Status da mensagem
          isAutoGenerated: false,  // Mensagem manual ou automática
          deviceInfo: message.device ? message.device : 'unknown',
          userName: profileName  // Nome do perfil no WhatsApp
        };

        console.log("Storing message in Redis:", messageData);

        await redisClient.hSet(`message:${message.id}`, {
          id: messageData.id,
          timestamp: messageData.timestamp,
          phoneNumber: messageData.phoneNumber,
          content: messageData.content,
          assistantId: messageData.assistantId,
          aiPhoneNumber: messageData.aiPhoneNumber,
          threadId: messageData.threadId,
          createdAt: messageData.createdAt,
          localTime: messageData.localTime,
          location: JSON.stringify(messageData.location), // Serialize the location
          type: messageData.type,
          status: messageData.status,
          isAutoGenerated: JSON.stringify(messageData.isAutoGenerated), // Serialize boolean
          deviceInfo: JSON.stringify(messageData.deviceInfo),
          userName: messageData.userName  // Nome do perfil no WhatsApp
        });

        console.log(`Message ID ${message.id} added to Redis with threadId ${threadId} and timestamp ${message.timestamp}`);

        // Verifique o tipo de mensagem
        if (message.text) {
          const userMessage = message.text.body.toLowerCase();

          // Verifique se a mensagem contém "apagar thread_id"
          if (userMessage.includes("apagar thread_id")) {
            const threadId = await redisClient.get(`threadId:${phoneNumber}`);

            if (threadId) {
              try {
                await openai.beta.threads.delete(threadId);
                console.log(`Thread ${threadId} deletado no OpenAI.`);
              } catch (error) {
                console.error(`Erro ao deletar thread no OpenAI:`, error);
              }

              await redisClient.del(`threadId:${phoneNumber}`);
              sendReply(req.body.entry[0].changes[0].value.metadata.phone_number_id, process.env.GRAPH_API_TOKEN, message.from, "Thread ID apagado com sucesso.", res);
            } else {
              sendReply(req.body.entry[0].changes[0].value.metadata.phone_number_id, process.env.GRAPH_API_TOKEN, message.from, "Nenhum thread ID encontrado para apagar.", res);
            }

            return;
          }

          // Verifique se já existe um buffer de mensagens para este telefone
          if (!messageBuffers.has(phoneNumber)) {
            messageBuffers.set(phoneNumber, []);
          }

          // Adicione a nova mensagem ao buffer
          messageBuffers.get(phoneNumber).push(message.text.body);

          // Se já existir um timeout ativo, limpe-o
          if (bufferTimeouts.has(phoneNumber)) {
            clearTimeout(bufferTimeouts.get(phoneNumber));
          }

          // Defina um novo timeout para processar as mensagens em 4 segundos
          bufferTimeouts.set(phoneNumber, setTimeout(async () => {
            // Enviar indicador de digitando e visto aqui, antes de processar a resposta
            await sendTypingOn(whatsappBusinessPhoneNumberId, accessToken, userMessageId);
            // Se necessário, enviar reação de sorriso
            if (shouldReactWithSmile) {
              const emojiToReactWith = "\uD83D\uDE00"; // Emoji de carinha feliz 😀
              await sendReactionToMessage(whatsappBusinessPhoneNumberId, accessToken, userPhoneNumberForReaction, userMessageId, emojiToReactWith);
            }
            // Recupere e concatene as mensagens
            const bufferedMessages = messageBuffers.get(phoneNumber).join(' ');
            messageBuffers.delete(phoneNumber);
            bufferTimeouts.delete(phoneNumber);

            // Exemplo de uso: se a mensagem do usuário contiver a palavra 'nutricionista', envie o contato
            const userMessageLower = bufferedMessages.toLowerCase();
            const hasFalar = userMessageLower.includes('falar');
            const hasConversar = userMessageLower.includes('conversar');
            const hasHumano = userMessageLower.includes('humano');
            const hasPessoa = userMessageLower.includes('pessoa');
            if ((hasHumano || hasPessoa) && (hasFalar || hasConversar)) {
              await sendContactMessage(whatsappBusinessPhoneNumberId, accessToken, message.from);
              await sendReply(
                whatsappBusinessPhoneNumberId,
                accessToken,
                message.from,
                "Esse é o Guilherme, membro da nossa equipe comercial!",
                null
              );
            }

            // Obtenha o threadId ou crie um novo
            let threadId = await redisClient.get(`threadId:${phoneNumber}`);
            const currentDate = moment().tz("America/Sao_Paulo").format('DD/MM/YYYY');

            if (!threadId) {
              const greeting = getTimeBasedGreeting();
              const formattedMessage = formatMessageWithDate(`${greeting} ${bufferedMessages} [Data: ${currentDate}]`, message.timestamp, profileName);
              const thread = await openai.beta.threads.create({
                messages: [{ role: "user", content: formattedMessage }],
                metadata: { phoneNumber: phoneNumber }
              });
              threadId = thread.id;
              await redisClient.set(`threadId:${phoneNumber}`, threadId);
              console.log(`Thread ID ${threadId} criado e armazenado para ${phoneNumber}`);

              // Armazena a mensagem do usuário
              await storeMessageInConversation(phoneNumber, threadId, {
                role: 'user',
                content: formattedMessage,
                timestamp: Date.now()
              });

              const run = await openai.beta.threads.runs.create(threadId, {
                assistant_id: process.env.ASSISTANT_ID
              });

              const completedRun = await waitForRunCompletion(threadId, run.id);
              const messagesResponse = await openai.beta.threads.messages.list(threadId);
              const assistantResponse = messagesResponse.data.find(m => m.role === 'assistant').content[0].text.value;

              // Armazena a mensagem do assistente
              await storeMessageInConversation(phoneNumber, threadId, {
                role: 'assistant',
                content: assistantResponse,
                timestamp: Date.now()
              });

              sendReply(req.body.entry[0].changes[0].value.metadata.phone_number_id, process.env.GRAPH_API_TOKEN, message.from, assistantResponse, res);
            } else {
              const totalTokens = await getTokenUsage(threadId);

              if (totalTokens > 1000000) {
                console.log(`Total de tokens excedeu 1.000.000 para o thread ${threadId}. Resumindo contexto...`);

                const summarizedContext = await summarizeContext(threadId);

                const newThread = await openai.beta.threads.create({
                  messages: [
                    { role: "user", content: "Esta é uma continuação da conversa anterior. Aqui está o resumo do contexto até agora:" },
                    { role: "user", content: summarizedContext }
                  ],
                  metadata: { phoneNumber: phoneNumber }
                });

                threadId = newThread.id;
                await redisClient.set(`threadId:${phoneNumber}`, threadId);
                console.log(`Novo thread ID ${threadId} criado com contexto resumido para ${phoneNumber}`);

                const formattedMessage = formatMessageWithDate(`${bufferedMessages} [Data: ${currentDate}]`, message.timestamp, profileName);

                // Armazena a mensagem do usuário
                await storeMessageInConversation(phoneNumber, threadId, {
                  role: 'user',
                  content: formattedMessage,
                  timestamp: Date.now()
                });

                await openai.beta.threads.messages.create(threadId, {
                  role: "user",
                  content: formattedMessage
                });

                const run = await openai.beta.threads.runs.create(threadId, {
                  assistant_id: process.env.ASSISTANT_ID
                });

                const completedRun = await waitForRunCompletion(threadId, run.id);
                const messagesResponse = await openai.beta.threads.messages.list(threadId);
                const assistantResponse = messagesResponse.data.find(m => m.role === 'assistant').content[0].text.value;

                // Armazena a mensagem do assistente
                await storeMessageInConversation(phoneNumber, threadId, {
                  role: 'assistant',
                  content: assistantResponse,
                  timestamp: Date.now()
                });

                sendReplyWithTimeout(req.body.entry[0].changes[0].value.metadata.phone_number_id, process.env.GRAPH_API_TOKEN, message.from, assistantResponse, res);
              } else {
                console.log(`Total de tokens para o thread ${threadId} ainda está abaixo de 1.000.000.`);
                const formattedMessage = formatMessageWithDate(`${bufferedMessages} [Data: ${currentDate}]`, message.timestamp, profileName);

                // Armazena a mensagem do usuário
                await storeMessageInConversation(phoneNumber, threadId, {
                  role: 'user',
                  content: formattedMessage,
                  timestamp: Date.now()
                });

                await addMessageWithRetry(threadId, formattedMessage);

                const run = await openai.beta.threads.runs.create(threadId, {
                  assistant_id: process.env.ASSISTANT_ID
                });

                const completedRun = await waitForRunCompletion(threadId, run.id);
                const messagesResponse = await openai.beta.threads.messages.list(threadId);
                const assistantResponse = messagesResponse.data.find(m => m.role === 'assistant').content[0].text.value;

                // Armazena a mensagem do assistente
                await storeMessageInConversation(phoneNumber, threadId, {
                  role: 'assistant',
                  content: assistantResponse,
                  timestamp: Date.now()
                });

                sendReplyWithTimeout(req.body.entry[0].changes[0].value.metadata.phone_number_id, process.env.GRAPH_API_TOKEN, message.from, assistantResponse, res);
              }
            }
          }, 4000)); // Timeout de 4 segundos
        }
        // Se for uma mensagem de áudio
        else if (message.audio) {
          const mediaId = message.audio.id;
          if (mediaId) {
            const audioUrl = await fetchMediaUrl(mediaId);
            const audioContent = await downloadAudio(audioUrl);

            const { transcription, language } = await transcribeAudio(audioContent);

            if (transcription) {
              let threadId = await redisClient.get(`threadId:${phoneNumber}`);

              if (!threadId) {
                const greeting = getTimeBasedGreeting();
                const thread = await openai.beta.threads.create({
                  messages: [{ role: "user", content: `${greeting} ${transcription}` }],
                  metadata: { phoneNumber: phoneNumber }
                });
                threadId = thread.id;
                await redisClient.set(`threadId:${phoneNumber}`, threadId);
              } else {
                await openai.beta.threads.messages.create(threadId, { role: "user", content: transcription });
              }

              // Armazena a mensagem do usuário
              await storeMessageInConversation(phoneNumber, threadId, {
                role: 'user',
                content: transcription,
                timestamp: Date.now()
              });

              const run = await openai.beta.threads.runs.create(threadId, {
                assistant_id: process.env.ASSISTANT_ID
              });

              const completedRun = await waitForRunCompletion(threadId, run.id);
              const messagesResponse = await openai.beta.threads.messages.list(threadId);
              const assistantResponse = messagesResponse.data.find(m => m.role === 'assistant').content[0].text.value;

              // Armazena a mensagem do assistente
              await storeMessageInConversation(phoneNumber, threadId, {
                role: 'assistant',
                content: assistantResponse,
                timestamp: Date.now()
              });

              await sendReply(req.body.entry[0].changes[0].value.metadata.phone_number_id, process.env.GRAPH_API_TOKEN, message.from, assistantResponse, res);
            } else {
              // Caso não tenha conseguido transcrever ou tenha muito ruído
              await sendReply(req.body.entry[0].changes[0].value.metadata.phone_number_id, process.env.GRAPH_API_TOKEN, message.from, "Desculpe, por enquanto não consigo ouvir seu áudio, poderia escrever?", res);
            }
          } else {
            console.error("Media ID is undefined");
          }
        }
        // Tratamento de imagens
        else if (message.image) {
          const mediaId = message.image.id;
          const caption = message.image.caption || "";
          let threadId = await redisClient.get(`threadId:${phoneNumber}`);

          if (mediaId) {
            const imageUrl = await fetchMediaUrl(mediaId);
            console.log("Image URL: ", imageUrl);

            sendReply(req.body.entry[0].changes[0].value.metadata.phone_number_id, process.env.GRAPH_API_TOKEN, message.from, "Recebi sua foto. Por favor, aguarde alguns instantes enquanto eu analiso! 🕵🔍", res);

            const description = await processImage(imageUrl, caption);

            if (description) {
              const instruction = `Essa é a descrição da imagem foi enviada por uma outra IA para você, Ultron. Use essa descrição para gerar sua resposta. Lembre-se essa mensagem foi enviada por outra IA, não pelo usuário. Use essas informações para gerar uma resposta para ser enviada ao usuário. Essa é a descrição da imagem e legenda que o usuário incluiu (se houver): ${description}`;

              // Armazena a mensagem do usuário (descrição da imagem)
              await storeMessageInConversation(phoneNumber, threadId, {
                role: 'user',
                content: instruction,
                timestamp: Date.now()
              });

              await addMessageWithRetry(threadId, instruction);

              const run = await openai.beta.threads.runs.create(threadId, {
                assistant_id: process.env.ASSISTANT_ID
              });

              const completedRun = await waitForRunCompletion(threadId, run.id);

              const messagesResponse = await openai.beta.threads.messages.list(threadId);
              const assistantResponse = messagesResponse.data.find(m => m.role === 'assistant').content[0].text.value;

              // Armazena a mensagem do assistente
              await storeMessageInConversation(phoneNumber, threadId, {
                role: 'assistant',
                content: assistantResponse,
                timestamp: Date.now()
              });

              sendReplyWithTimeout(req.body.entry[0].changes[0].value.metadata.phone_number_id, process.env.GRAPH_API_TOKEN, message.from, assistantResponse, res);
            }
          } else {
            console.error("Media ID is undefined");
          }
        }
        // Tratamento de documentos PDF
        else if (message.document && message.document.mime_type === "application/pdf") {
          const mediaId = message.document.id;
          let threadId = await redisClient.get(`threadId:${phoneNumber}`);
          const mediaUrl = await fetchMediaUrl(mediaId);

          sendReply(req.body.entry[0].changes[0].value.metadata.phone_number_id, process.env.GRAPH_API_TOKEN, message.from, "Um momento, vou analisar o documento enviado.🕵🏻‍♂️🔍", res);

          const pdfContent = await downloadPdf(mediaUrl);
          const extractedText = await extractTextFromPdf(pdfContent);

          const instruction = `Este é o texto do arquivo enviado. Responda de forma didática.`;
          const content = `${instruction}\n\nTexto extraído do PDF:\n${extractedText}`;

          if (!threadId) {
            const greeting = getTimeBasedGreeting();
            const thread = await openai.beta.threads.create({
              messages: [{ role: "user", content: `${greeting} ${content}` }],
              metadata: { phoneNumber: phoneNumber }
            });
            threadId = thread.id;
            await redisClient.set(`threadId:${phoneNumber}`, threadId);
          } else {
            await openai.beta.threads.messages.create(threadId, {
              role: "user",
              content: content
            });
          }

          // Armazena a mensagem do usuário (conteúdo do PDF)
          await storeMessageInConversation(phoneNumber, threadId, {
            role: 'user',
            content: content,
            timestamp: Date.now()
          });

          const confirmationMessage = "Documento analisado, já podemos falar sobre ele.";
          sendReply(req.body.entry[0].changes[0].value.metadata.phone_number_id, process.env.GRAPH_API_TOKEN, message.from, confirmationMessage, res);
        }
      }
    } else {
      res.sendStatus(200);
    }
  } catch (error) {
    console.error("Error during message handling:", error);
    res.sendStatus(500);
  }
});

function getTimeBasedGreeting() {
  const now = moment().tz("America/Sao_Paulo");
  console.log("Hora atual em São Paulo:", now.format('HH:mm'));

  if (now.hours() < 12) {
    return "Bom dia";
  } else if (now.hours() < 18) {
    return "Boa tarde";
  } else {
    return "Boa noite";
  }
}

async function waitForRunCompletion(threadId, runId, maxRetries = 20, delay = 2000) {
  let retries = 0;
  let run = await openai.beta.threads.runs.retrieve(threadId, runId);

  while ((run.status === 'queued' || run.status === 'in_progress') && retries < maxRetries) {
    await new Promise(resolve => setTimeout(resolve, 2000));  // Redução do tempo de espera
    run = await openai.beta.threads.runs.retrieve(threadId, runId);
    retries++;
    console.log(`Tentativa ${retries}: status do run é ${run.status}`);
  }

  if (run.status === 'queued' || run.status === 'in_progress') {
    console.warn(`Run ${runId} no thread ${threadId} ainda está em progresso após ${retries} tentativas.`);
    throw new Error(`O Run ${runId} não foi completado após ${retries} tentativas`);
  }

  console.log(`Run ${runId} no thread ${threadId} foi completado com sucesso.`);
  return run;
}

// Modifique a função sendReply para lidar com o TTS da OpenAI
async function sendReply(phone_number_id, whatsapp_token, to, reply_message, resp, isAudio = false, messageId = null) {
  let json;

  if (isAudio) {
    try {
      const audioContent = await textToSpeech(reply_message);
      const audioFileName = `response_${messageId || uuidv4()}.ogg`;  // Salvando como .ogg com codec opus
      const audioPath = path.join(__dirname, 'audio_responses', audioFileName);

      // Certifique-se de que o diretório 'audio_responses' exista
      if (!fs.existsSync(path.join(__dirname, 'audio_responses'))) {
        fs.mkdirSync(path.join(__dirname, 'audio_responses'));
      }

      // Salva o arquivo de áudio gerado pela OpenAI
      fs.writeFileSync(audioPath, audioContent, 'binary');

      // Monta o JSON para enviar o áudio
      json = {
        messaging_product: "whatsapp",
        to: to,
        type: "audio",
        audio: {
          link: `${process.env.SERVER_URL}/audio/${audioFileName}`  // Certifique-se de que o link seja acessível
        }
      };
    } catch (error) {
      console.error("Erro ao converter texto para áudio (OpenAI):", error);
      if (resp && !resp.headersSent) {
        resp.sendStatus(500);
      }
      return;
    }
  } else {
    // Mantém o envio de mensagens de texto inalterado
    json = {
      messaging_product: "whatsapp",
      to: to,
      text: { body: reply_message }
    };
  }

  const data = JSON.stringify(json);
  const requestPath = `/v19.0/${phone_number_id}/messages?access_token=${whatsapp_token}`;
  const options = {
    host: "graph.facebook.com",
    path: requestPath,
    method: "POST",
    headers: { "Content-Type": "application/json" }
  };

  console.log(`Enviando mensagem para o número: ${to} com mensagem: ${reply_message}`);

  const req = https.request(options, (response) => {
    let responseData = '';
    response.on('data', (chunk) => {
      responseData += chunk;
    });

    response.on('end', () => {
      console.log(`Resposta da API do WhatsApp: ${responseData}`);

      if (response.statusCode !== 200) {
        console.error(`Falha ao enviar mensagem para o número ${to}. Código de status: ${response.statusCode}, Resposta: ${responseData}`);
      }

      if (resp && !resp.headersSent) {
        resp.sendStatus(response.statusCode);
      }
    });
  });

  req.on("error", (e) => {
    console.error(`Erro ao enviar a mensagem para o número ${to}:`, e.message);

    if (resp && !resp.headersSent) {
      resp.sendStatus(500);
    }
  });

  req.write(data);
  req.end();
}

// Rota para servir arquivos de áudio
app.get('/audio/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'audio_responses', filename);

  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', 'audio/ogg; codecs=opus');  // Definindo o tipo MIME correto para OGG
    res.sendFile(filePath);
  } else {
    res.status(404).send('Arquivo não encontrado');
  }
});

// Nova função para enviar resposta com timeout
async function sendReplyWithTimeout(phone_number_id, whatsapp_token, to, reply_message, resp, delayMessage = "Hmm, só um instante...") {
  let isReplySent = false;

  // Envia a mensagem de atraso após 2 segundos, a menos que a resposta já tenha sido enviada
  const delayTimeout = setTimeout(() => {
    if (!isReplySent) {
      sendReply(phone_number_id, whatsapp_token, to, delayMessage, null);
    }
  }, 2000);

  // Função que será chamada quando a resposta da IA for obtida
  const sendFinalReply = (finalMessage) => {
    clearTimeout(delayTimeout);
    sendReply(phone_number_id, whatsapp_token, to, finalMessage, resp);
    isReplySent = true;
  };

  // Aqui você chama a função que obtém a resposta da OpenAI
  try {
    sendFinalReply(reply_message);
  } catch (error) {
    console.error("Erro ao obter a resposta da OpenAI:", error);
    sendFinalReply("Desculpe, houve um problema ao processar sua solicitação.");
  }
}

async function fetchMediaUrl(mediaId) {
  try {
    const url = `https://graph.facebook.com/v19.0/${mediaId}`;
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${process.env.GRAPH_API_TOKEN}`
      }
    });
    console.log("Media URL response:", response.data);
    return response.data.url;
  } catch (error) {
    console.error("Error fetching media URL:", error);
    throw error;
  }
}

async function processImage(imageUrl, caption) {
  try {
    const imagePath = await downloadImage(imageUrl);
    console.log("Image downloaded to:", imagePath);
    const description = await describeImage(imagePath, caption);
    fs.unlinkSync(imagePath);
    return description;
  } catch (error) {
    console.error("Error processing image:", error);
    throw error;
  }
}

async function downloadImage(url) {
  const imagePath = path.join(__dirname, 'temp_image.jpg');
  const writer = fs.createWriteStream(imagePath);

  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
    headers: {
      Authorization: `Bearer ${process.env.GRAPH_API_TOKEN}`
    }
  });

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', () => resolve(imagePath));
    writer.on('error', reject);
  });
}

async function describeImage(imagePath, caption) {
  const imageBuffer = fs.readFileSync(imagePath);
  const base64Image = imageBuffer.toString('base64');
  const messages = [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": `Responda com base na foto enviada e na legenda. A legenda fornecida pelo usuário é: ${caption}`
        },
        {
          "type": "image_url",
          "image_url": {
            "url": `data:image/jpeg;base64,${base64Image}`
          }
        }
      ]
    }
  ];

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: messages,
      max_tokens: 2000
    });
    console.log("Image description result:", response.choices[0].message.content);
    return response.choices[0].message.content;
  } catch (error) {
    console.error("Error describing image:", error);
    throw error;
  }
}

async function downloadPdf(url) {
  try {
    const response = await axios.get(url, {
      responseType: "arraybuffer",
      headers: {
        Authorization: `Bearer ${process.env.GRAPH_API_TOKEN}`
      }
    });
    return response.data;
  } catch (error) {
    console.error("Error downloading PDF:", error);
    throw error;
  }
}

async function extractTextFromPdf(pdfContent) {
  try {
    const data = await pdf(pdfContent);
    return data.text;
  } catch (error) {
    console.error("Error extracting text from PDF:", error);
    throw error;
  }
}

async function getOpenAIResponse(content) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "user", content: content }
      ],
      max_tokens: 2000
    });
    return response.choices[0].message.content;
  } catch (error) {
    console.error("Error getting OpenAI response:", error);
    throw error;
  }
}

async function downloadAudio(url) {
  try {
    const response = await axios.get(url, {
      responseType: "arraybuffer",
      headers: {
        Authorization: `Bearer ${process.env.GRAPH_API_TOKEN}`
      }
    });
    return response.data;
  } catch (error) {
    console.error("Error downloading audio:", error);
    throw error;
  }
}

async function transcribeAudio(audioContentBuffer) {
  const tempAudioPath = path.join(__dirname, `temp_audio_${Date.now()}.ogg`);
  fs.writeFileSync(tempAudioPath, audioContentBuffer);

  try {
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempAudioPath),
      model: "whisper-1",
      response_format: "json",
      language: "pt" // Defina o idioma desejado
    });

    const transcriptionText = transcription.text.trim();
    fs.unlinkSync(tempAudioPath);

    // Caso a transcrição esteja vazia ou com muito barulho
    if (!transcriptionText || transcriptionText.length < 5) {
      throw new Error("Transcrição com muito ruído ou não detectada");
    }

    return {
      transcription: transcriptionText,
      language: "pt-BR"
    };
  } catch (error) {
    console.error("Erro ao transcrever o áudio com Whisper:", error);
    fs.unlinkSync(tempAudioPath);
    return null;  // Retorna nulo para indicar falha na transcrição
  }
}

async function textToSpeech(text) {
  const voice = 'onyx'; // Defina a voz padrão
  const model = "tts-1"; // Use o modelo padrão

  try {
    // Solicita a conversão de texto para áudio usando o TTS da OpenAI
    const response = await openai.audio.speech.create({
      model: model,
      voice: voice,
      input: text,
      response_format: "opus" // Usar o formato de resposta "opus"
    });

    // Converte a resposta em um buffer para salvar como arquivo de áudio
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer;
  } catch (error) {
    console.error("Erro ao converter texto para áudio (OpenAI):", error);
    throw error;
  }
}

app.use('/response.mp3', express.static(path.join(__dirname, 'response.mp3')));

async function isRunActive(threadId) {
  const runs = await openai.beta.threads.runs.list(threadId);
  return runs.data.some(run => run.status === 'queued' || run.status === 'in_progress');
}

export default app;
