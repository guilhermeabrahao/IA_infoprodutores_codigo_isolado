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
import cron from 'node-cron';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

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

function formatMessageWithDate(message, timestamp) {
    const messageDate = moment(timestamp * 1000).tz("America/Sao_Paulo").format('DD/MM/YYYY');
    return `${messageDate}: ${message}`;
}

// Mapa para controlar operações simultâneas em threads
let runningOperations = {};

// Map para armazenar mensagens temporariamente
const messageBuffers = new Map();
const bufferTimeouts = new Map();

// Função para esperar até que não haja mais runs ativos
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

async function isPhoneNumberInRedis(phoneNumber) {
    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    const userKey = `user:${normalizedPhone}`;

    // Verificar se o usuário com o telefone normalizado existe e está ativo
    const userStatus = await redisClient.hGet(userKey, 'status');
    return userStatus === 'active';
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
                { role: "user", content: "Analise a conversa e identifique as seguintes informações do usuário: Idade, peso, altura, sexo, nível de atividade física, meta de calorias mais recente, calorias basais mais recentes. Inclua um breve contexto das últimas 4 mensagens trocadas entre a IA e o usuário. Comece com a frase: 'Esse é apenas o contexto da conversa, não envie ao usuário.' Exemplo de resposta que você deve enviar: 'Atenção: Esse é apenas o contexto da conversa, não envie ao usuário. Informações: Idade: 31, peso: 100kg, altura: 1,80, sexo: Masculino, nível de atividade física: Levemente ativo. A data da mensagem mais recente enviada pelo usuário é [XX/XX/XX]. Aqui estão as informações nutricionais do usuário mais atualizadas (mais recentes): 🎯 Meta de calorias do dia [XX/XX/XX]: 1719 kcal 🏅 (pule uma linha) 🍞 Meta de Carboidratos: 172 gramas (pule uma linha) 🍗 Meta de Proteína: 129 gramas (pule uma linha) 🥑 Meta de Gorduras: 57 gramas (pule uma linha) Consumo do dia para o dia de hoje [XX/XX/XX] (aqui você insere a data real) [Atualizado] (pule uma linha) 🔥 Calorias consumidas: 1200 kcal (pule uma linha) 🥩 Proteínas consumidas: 90g (pule uma linha) 🧈 Gorduras consumidas: 40g (pule uma linha) 🥖 Carboidratos consumidos: 120g (pule uma linha) 🥇Saldo restante para o dia de hoje [XX/XX/XX] [Atualizado]: (pule uma linha) 🔥 Calorias restantes: 519 kcal  (pule uma linha) 🥩 Proteínas restantes: 38,9g  (pule uma linha) 🧈 Gorduras restantes: 17,3g  (pule uma linha) 🥖 Carboidratos restantes: 51,9g (pule uma linha)  _Continue firme! Estamos no caminho certo para alcançar seus objetivos._ 🏆💪😃 (pule uma linha) Aqui está um breve contexto das últimas mensagens trocadas: (aqui você insere o contexto real)" },
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

async function sendTypingOn(whatsappBusinessPhoneNumberId, accessToken, userMessageId) { // Adicionado userMessageId
    const apiVersion = process.env.GRAPH_API_VERSION || "v22.0";
    const apiUrl = `https://graph.facebook.com/${apiVersion}/${whatsappBusinessPhoneNumberId}/messages`;
    const data = {
        messaging_product: "whatsapp",
        status: "read", // Adicionado conforme exemplo do usuário
        message_id: userMessageId, // Adicionado conforme exemplo do usuário
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

async function sendReactionToMessage(whatsappBusinessPhoneNumberId, accessToken, userPhoneNumber, messageId, emoji) {
    const apiVersion = process.env.GRAPH_API_VERSION || "v22.0";
    const apiUrl = `https://graph.facebook.com/${apiVersion}/${whatsappBusinessPhoneNumberId}/messages`;
    const data = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: userPhoneNumber, // WhatsApp user phone number
        type: "reaction",
        reaction: {
            message_id: messageId, // ID of the message to react to
            emoji: emoji // Emoji to react with (e.g., "\uD83D\uDE00")
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
        // Do not rethrow, as reacting is a secondary action
    }
}

app.post("/webhook", async (req, res) => {
    try {
        console.log("Webhook received:", JSON.stringify(req.body, null, 2));
        if (!req.body.object) {
            console.log("Invalid webhook object");
            res.sendStatus(404);
            return;
        }

        const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        console.log("Received message:", JSON.stringify(message, null, 2));
        if (message && message.from) {
            const whatsappBusinessPhoneNumberId = req.body.entry[0].changes[0].value.metadata.phone_number_id;
            const accessToken = process.env.GRAPH_API_TOKEN;
            const userMessageId = message.id; // ID da mensagem recebida do usuário
            const userPhoneNumberForReaction = message.from; // Número original do usuário para a API de reação

            if (message.text && message.text.body && message.text.body.toLowerCase().includes("sim")) {
                const emojiToReactWith = "\uD83D\uDE00"; // Emoji de carinha feliz 😀
                console.log(`Message contains 'sim'. Reacting first to message ID: ${userMessageId} from user: ${userPhoneNumberForReaction}.`);
                await sendReactionToMessage(whatsappBusinessPhoneNumberId, accessToken, userPhoneNumberForReaction, userMessageId, emojiToReactWith);
                // Agora, enviar o indicador de digitando e marcar como lida
                console.log(`Now sending typing_on for message ID: ${userMessageId}`);
                await sendTypingOn(whatsappBusinessPhoneNumberId, accessToken, userMessageId);
            } else {
                // Se não houver "sim", apenas enviar o indicador de digitando e marcar como lida
                console.log(`Message does not contain 'sim'. Sending typing_on for message ID: ${userMessageId}`);
                await sendTypingOn(whatsappBusinessPhoneNumberId, accessToken, userMessageId);
            }

            const phoneNumber = normalizePhoneNumber(message.from);
            console.log("Normalized phone number:", phoneNumber);

            const phoneExists = await isPhoneNumberInRedis(phoneNumber);
            console.log(`Phone number ${phoneNumber} exists in Redis:`, phoneExists);

            if (!phoneExists) {
                const messageText =
                    "Olá! Bem-vindo(a) à *NutriFy*! 🍇\n" +
                    "Seu acompanhamento nutricional nunca foi tão prático. 😉 \n\n" +
                    "Após fazer sua assinatura, volte ao contato e *peça um diagnóstico inicial*! 🤖\n\n" +
                    "Link para a assinatura 📲: https://linktr.ee/nutri.fy"

                sendReply(
                    req.body.entry[0].changes[0].value.metadata.phone_number_id,
                    process.env.GRAPH_API_TOKEN,
                    message.from,
                    messageText,
                    res
                );
                return;
            }

            const existingMessageData = await redisClient.hGetAll(`message:${message.id}`);
            console.log(`Message data in Redis for ID ${message.id}:`, existingMessageData);

            if (existingMessageData && existingMessageData.timestamp && existingMessageData.timestamp === String(message.timestamp)) {
                console.log("Mensagem duplicada ignorada.");
                res.sendStatus(200);
            } else {
                await redisClient.hSet(`message:${message.id}`, {
                    id: message.id,
                    timestamp: message.timestamp
                });
                console.log(`Message ID ${message.id} added to Redis with timestamp ${message.timestamp}`);

                await resetDailyCaloricIntakeIfNeeded(phoneNumber);

                // Verifique o tipo de mensagem
                if (message.text) {
                    // Verifique se a mensagem contém "apagar thread_id"
                    const userMessage = message.text.body.toLowerCase();

                    if (userMessage.includes("apagar thread_id")) {
                        await redisClient.del(`threadId:${phoneNumber}`);
                        sendReply(req.body.entry[0].changes[0].value.metadata.phone_number_id, process.env.GRAPH_API_TOKEN, message.from, "Thread ID apagado com sucesso.", res);
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
                        // Recupere e concatene as mensagens
                        const bufferedMessages = messageBuffers.get(phoneNumber).join(' ');
                        messageBuffers.delete(phoneNumber);
                        bufferTimeouts.delete(phoneNumber);

                        // Obtenha o threadId ou crie um novo
                        let threadId = await redisClient.get(`threadId:${phoneNumber}`);
                        const currentDate = moment().tz("America/Sao_Paulo").format('DD/MM/YYYY');

                        if (!threadId) {
                            const greeting = getTimeBasedGreeting();
                            const formattedMessage = formatMessageWithDate(`${greeting} ${bufferedMessages} [Data: ${currentDate}]`, message.timestamp);
                            const thread = await openai.beta.threads.create({
                                messages: [{ role: "user", content: formattedMessage }],
                                metadata: { phoneNumber: phoneNumber }
                            });
                            threadId = thread.id;
                            await redisClient.set(`threadId:${phoneNumber}`, threadId);
                            console.log(`Thread ID ${threadId} criado e armazenado para ${phoneNumber}`);

                            const run = await openai.beta.threads.runs.create(threadId, {
                                assistant_id: assistantIdGlobal
                            });

                            const completedRun = await waitForRunCompletion(threadId, run.id);
                            const messagesResponse = await openai.beta.threads.messages.list(threadId);
                            const assistantResponse = messagesResponse.data.find(m => m.role === 'assistant').content[0].text.value;

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

                                const formattedMessage = formatMessageWithDate(`${bufferedMessages} [Data: ${currentDate}]`, message.timestamp);
                                await openai.beta.threads.messages.create(threadId, {
                                    role: "user",
                                    content: formattedMessage
                                });

                                const run = await openai.beta.threads.runs.create(threadId, {
                                    assistant_id: assistantIdGlobal
                                });

                                const completedRun = await waitForRunCompletion(threadId, run.id);
                                const messagesResponse = await openai.beta.threads.messages.list(threadId);
                                const assistantResponse = messagesResponse.data.find(m => m.role === 'assistant').content[0].text.value;

                                sendReplyWithTimeout(req.body.entry[0].changes[0].value.metadata.phone_number_id, process.env.GRAPH_API_TOKEN, message.from, assistantResponse, res);
                            } else {
                                console.log(`Total de tokens para o thread ${threadId} ainda está abaixo de 1.000.000.`);
                                const formattedMessage = formatMessageWithDate(`${bufferedMessages} [Data: ${currentDate}]`, message.timestamp);
                                await addMessageWithRetry(threadId, formattedMessage);

                                const run = await openai.beta.threads.runs.create(threadId, {
                                    assistant_id: assistantIdGlobal
                                });

                                const completedRun = await waitForRunCompletion(threadId, run.id);
                                const messagesResponse = await openai.beta.threads.messages.list(threadId);
                                const assistantResponse = messagesResponse.data.find(m => m.role === 'assistant').content[0].text.value;

                                sendReplyWithTimeout(req.body.entry[0].changes[0].value.metadata.phone_number_id, process.env.GRAPH_API_TOKEN, message.from, assistantResponse, res);
                            }
                        }
                    }, 4000)); // Timeout de 4 segundos
                } else if (message.audio) {
                    const mediaId = message.audio.id;
                    if (mediaId) {
                        sendReply(req.body.entry[0].changes[0].value.metadata.phone_number_id, process.env.GRAPH_API_TOKEN, message.from, "Um momento, vou escutar o áudio enviado. 🤖🔊", null);

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

                            const run = await openai.beta.threads.runs.create(threadId, {
                                assistant_id: assistantIdGlobal
                            });

                            const completedRun = await waitForRunCompletion(threadId, run.id);
                            const messagesResponse = await openai.beta.threads.messages.list(threadId);
                            const assistantResponse = messagesResponse.data.find(m => m.role === 'assistant').content[0].text.value;

                            await sendReply(req.body.entry[0].changes[0].value.metadata.phone_number_id, process.env.GRAPH_API_TOKEN, message.from, assistantResponse, res);
                        } else {
                            await sendReply(req.body.entry[0].changes[0].value.metadata.phone_number_id, process.env.GRAPH_API_TOKEN, message.from, "Desculpe, por enquanto não consigo ouvir seu áudio, poderia escrever?", res);
                        }
                    } else {
                        console.error("Media ID is undefined");
                    }
                } else if (message.image) {
                    const mediaId = message.image.id;
                    const caption = message.image.caption || "";
                    let threadId = await redisClient.get(`threadId:${phoneNumber}`);  // Adicionado para garantir que o threadId esteja disponível
                    if (mediaId) {
                        const imageUrl = await fetchMediaUrl(mediaId);
                        console.log("Image URL: ", imageUrl);

                        sendReply(req.body.entry[0].changes[0].value.metadata.phone_number_id, process.env.GRAPH_API_TOKEN, message.from, "Recebi sua foto. Por favor, aguarde alguns instantes enquanto eu analiso! 🕵🔍", res);

                        const description = await processImage(imageUrl, caption);

                        if (description) {
                            sendReply(req.body.entry[0].changes[0].value.metadata.phone_number_id, process.env.GRAPH_API_TOKEN, message.from, description, res);

                            await addMessageWithRetry(threadId, description);

                            const run = await openai.beta.threads.runs.create(threadId, {
                                assistant_id: assistantIdGlobal
                            });

                            const completedRun = await waitForRunCompletion(threadId, run.id);
                            const messagesResponse = await openai.beta.threads.messages.list(threadId);
                            const assistantResponse = messagesResponse.data.find(m => m.role === 'assistant').content[0].text.value;

                            sendReplyWithTimeout(req.body.entry[0].changes[0].value.metadata.phone_number_id, process.env.GRAPH_API_TOKEN, message.from, assistantResponse, res);
                        }
                    } else {
                        console.error("Media ID is undefined");
                    }
                } else if (message.document && message.document.mime_type === "application/pdf") {
                    const mediaId = message.document.id;
                    let threadId = await redisClient.get(`threadId:${phoneNumber}`);  // Adicionado para garantir que o threadId esteja disponível
                    const mediaUrl = await fetchMediaUrl(mediaId);

                    sendReply(req.body.entry[0].changes[0].value.metadata.phone_number_id, process.env.GRAPH_API_TOKEN, message.from, "Um momento, vou analisar o documento enviado.🕵🏻‍♂️🔍", res);

                    const pdfContent = await downloadPdf(mediaUrl);
                    const extractedText = await extractTextFromPdf(pdfContent);

                    const instruction = `Se for uma prescrição de dieta, monte uma lista de mercado resumida para que a pessoa consiga comprar os alimentos ali descritos para o período que a dieta foi prescrita. Esse texto será enviado no WhatsApp, então sempre use formatação de texto em negrito (somente * antes e * depois da palavra ou frase, exemplo *Essa é sua lista de mercado:*), itálico (somente _ antes e _ depois da palavra ou frase, exemplo _Café da manhã:_) e alguns poucos emojis para ficar bonito. A lista deve ser curta, objetiva e lógica com intuito de facilitar o entendimento. Comece a resposta com "Aqui está sua lista de mercado:" e aí escreva a lista. Quando for descrever os itens, especifique primeiro a quantidade e em seguida o item que deve ser comprado (Exemplo: 1 kg de frango). As quantidades de cada item devem atender o período que a pessoa terá que seguir a dieta. Exemplo: se a dieta for para 1 semana (7 dias) e em todas as refeições do almoço (separada por opções) tiver 100g de frango, então a pessoa terá que comprar 700g de frango. Se a lista tiver "Opção 1" e "Opção 2" etc., então separe os itens da lista entre as opções. Lembre-se que os alimentos devem ser o suficiente para o período que a pessoa seguirá a dieta.`;
                    const content = `${instruction}\n\nTexto extraído do PDF:\n${extractedText}`;

                    const openaiResponse = await getOpenAIResponse(content);

                    await addMessageWithRetry(threadId, openaiResponse);

                    sendReplyWithTimeout(req.body.entry[0].changes[0].value.metadata.phone_number_id, process.env.GRAPH_API_TOKEN, message.from, openaiResponse, res);
                } else {
                    sendReply(req.body.entry[0].changes[0].value.metadata.phone_number_id, process.env.GRAPH_API_TOKEN, message.from, "Não consegui entender sua mensagem. Como posso ajudar você hoje? Se tiver alguma pergunta ou precisar de assistência, estou à disposição.", res);
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

async function resetDailyCaloricIntakeIfNeeded(phoneNumber) {
    const today = moment().tz("America/Sao_Paulo").format('YYYY-MM-DD');
    const lastUpdate = await redisClient.get(`caloriesLastUpdate:${phoneNumber}`);
    const dailyTarget = await redisClient.get(`dailyCaloricTarget:${phoneNumber}`) || 2000;

    if (lastUpdate !== today) {
        await redisClient.set(`caloriesLastUpdate:${phoneNumber}`, today);
        await redisClient.set(`caloricBalance:${phoneNumber}`, dailyTarget);
        console.log(`Caloric intake reset for ${phoneNumber}. New balance: ${dailyTarget}`);
    } else {
        console.log(`No reset needed for ${phoneNumber}. Last update: ${lastUpdate}`);
    }
}

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

async function waitForRunCompletion(threadId, runId, maxRetries = 20, delay = 5000) {
    let retries = 0;
    let run = await openai.beta.threads.runs.retrieve(threadId, runId);

    while ((run.status === 'queued' || run.status === 'in_progress' || run.status === 'requires_action') && retries < maxRetries) {
        if (run.status === 'requires_action') {
            console.log(`Run ${runId} requer ação. Executando function calls...`);
            
            if (run.required_action && run.required_action.type === 'submit_tool_outputs') {
                const toolCalls = run.required_action.submit_tool_outputs.tool_calls;
                
                const toolOutputs = [];
                
                for (const toolCall of toolCalls) {
                    const functionCall = toolCall.function;
                    console.log(`Executando function call: ${functionCall.name}`);
                    
                    try {
                        await handleFunctionCall(functionCall, threadId, runId);
                        // Se chegou aqui, a função foi executada com sucesso
                        // O output já foi enviado pela handleFunctionCall
                    } catch (error) {
                        console.error(`Erro ao executar function call ${functionCall.name}:`, error);
                        toolOutputs.push({
                            tool_call_id: toolCall.id,
                            output: `Erro ao executar ${functionCall.name}: ${error.message}`
                        });
                    }
                }
                
                // Se houve erros, envia os outputs de erro
                if (toolOutputs.length > 0) {
                    await openai.beta.threads.runs.submitToolOutputs(threadId, runId, {
                        tool_outputs: toolOutputs
                    });
                }
            }
        }
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        run = await openai.beta.threads.runs.retrieve(threadId, runId);
        retries++;
        console.log(`Tentativa ${retries}: status do run é ${run.status}`);
    }

    if (run.status === 'queued' || run.status === 'in_progress' || run.status === 'requires_action') {
        console.warn(`Run ${runId} no thread ${threadId} ainda está em progresso após ${retries} tentativas.`);
        throw new Error(`O Run ${runId} não foi completado após ${retries} tentativas`);
    }

    console.log(`Run ${runId} no thread ${threadId} foi completado com sucesso.`);
    return run;
}

// Modifique a função sendReply para lidar com o TTS da OpenAI
async function sendReply(phone_number_id, whatsapp_token, to, reply_message, resp, messageId = null) {
    let json;
    // Mantém o envio de mensagens de texto inalterado
    json = {
        messaging_product: "whatsapp",
        to: to,
        text: { body: reply_message }
    };

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

    const systemPrompt = {
        "role": "system",
        "content": `Você é uma IA especializada em análise nutricional precisa. Ao analisar fotos de alimentos:

1. Primeiro, identifique todos os itens alimentares visíveis e suas porções aproximadas.
2. Para cada item alimentar:
   - Estime o tamanho da porção com base em referências visuais (tamanho do prato, utensílios)
   - Utilize referências padrão de porção (ex.: 1 xícara = 240ml)
   - Considere a profundidade e densidade dos alimentos
   - Leve em conta os métodos de preparo que afetam volume/peso
3. Para cálculos de calorias/macronutrientes:
   - Use valores do banco de dados USDA como referência
   - Considere o método de preparo (cru, cozido, frito etc.)
   - Aplique estimativas conservadoras em caso de incerteza
4. Sempre forneça níveis de confiança:
   - Alto: Visão clara, porções padronizadas
   - Médio: Visão parcial, porções estimadas  
   - Baixo: Visão pouco clara, estimativas altamente aproximadas
5. Formate a resposta da seguinte forma:

   *Itens Alimentares Identificados:*
   - Item 1: [porção] ([confiança])
   - Item 2: [porção] ([confiança])
   
   *Estimativas Nutricionais:*
   🔥 Calorias: [faixa] kcal
   🥩 Proteína: [faixa]g
   🥖 Carboidratos: [faixa]g  
   🧈 Gorduras: [faixa]g
   `
    };

    const userPrompt = {
        "role": "user",
        "content": [
            {
                "type": "text",
                "text": `Por favor, analise esta imagem de comida e forneça estimativas nutricionais. Se na foto contiver uma pessoa, mensure a composição corporal aproximada da pessoa. Porém, se não for possível, diga que para obter uma avaliação precisa da composição corporal, é recomendado a consulta de um profissional de saúde, como um nutricionista ou um personal trainer, que podem usar métodos precisos, como a bioimpedância ou a medição da gordura corporal com o auxílio de um adipômetro. Se a foto for de uma tabela nutricional, você deve descrever as calorias e quantidades de macronutrientes que estiverem na tabela nutricial (calorias, carboidratos, proteínas e gorduras). Se a foto contiver alimentos,estime a quantidade de cada alimento emgramas, estime a quantidade de calorias que o alimento da foto possui (seja conservador, use fontes confiáveis, mas não cite o nome MyFitnessPal). Além do total de calorias, descreva o alimento ou alimentos que estão na foto. Exemplo 1: Prato de arroz, feijão e filé de frango. Exemplo 2: Iogurte Proteíco da Danone YouPRO. Descreva também a estimativa de macronutrientes (proteína, carboidrato e gordura). Para encontrar os valores nutricionais, use fontes confiáveis. Os títulos devem estar entre '*' e '*'. Sempre use emojis comuns do WhatsApp para ilustrar os alimentos. O total de calorias você deve colocar depois de 'Calorias totais:'. Não precisa dizer que as calorias e macronutrientes são estimadas, pois já sei disso. Aqui estão alguns dados de alimentos que podem aparecer: 1 unidade de pão francês (50 gramas): Calorias: 150 kcal, Carboidratos: 29g, Proteínas: 4g, Lipídeos: 1,55g. 100g de batata frita: Calorias: 274 kcal, Carboidratos: 35g, Proteínas: 3g, Lipídeos: 14g. Importante: essas informações são estimativas, então devem ser perguntadas ao usuário se estão corretas só devem ser contabilizadas se o usuário confirmou ou modificou os dados estimados, não atualize por conta propria. Legenda fornecida pelo usuário: ${caption}`
            },
            {
                "type": "image_url",
                "image_url": {
                    "url": `data:image/jpeg;base64,${base64Image}`
                }
            }
        ]
    };

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [systemPrompt, userPrompt],
            max_tokens: 2000,
            temperature: 0.2 // Temperatura baixa para estimativas mais conservadoras
        });

        // Pós-processamento da resposta para garantir clareza nas faixas e níveis de confiança
        let result = response.choices[0].message.content;

        // Adiciona um lembrete para confirmar a precisão
        result += "\n\n✅ Esses valores estão precisos para suas porções? Confirme ou informe se precisar de ajustes.";

        return result;

    } catch (error) {
        console.error("Erro ao analisar imagem de comida:", error);
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

// === TOOLS PARA O AGENTE OPENAI ===
export const assistantTools = [
    {
        type: "function",
        function: {
            name: "atualizarMetasDiarias",
            description: "Atualiza as metas diárias de calorias, proteínas, carboidratos e gorduras do usuário.",
            parameters: {
                type: "object",
                properties: {
                    phoneNumber: { type: "string", description: "Telefone do usuário" },
                    meta_calorias: { type: "number", description: "Meta diária de calorias" },
                    meta_proteinas: { type: "number", description: "Meta diária de proteínas" },
                    meta_carboidratos: { type: "number", description: "Meta diária de carboidratos" },
                    meta_gorduras: { type: "number", description: "Meta diária de gorduras" }
                },
                required: ["phoneNumber", "meta_calorias", "meta_proteinas", "meta_carboidratos", "meta_gorduras"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "atualizarConsumoDiario",
            description: "Atualiza os valores consumidos no dia de calorias, proteínas, carboidratos e gorduras do usuário.",
            parameters: {
                type: "object",
                properties: {
                    phoneNumber: { type: "string", description: "Telefone do usuário" },
                    calorias_dia: { type: "number", description: "Calorias consumidas no dia" },
                    proteinas_dia: { type: "number", description: "Proteínas consumidas no dia" },
                    carboidratos_dia: { type: "number", description: "Carboidratos consumidos no dia" },
                    gorduras_dia: { type: "number", description: "Gorduras consumidas no dia" }
                },
                required: ["phoneNumber", "calorias_dia", "proteinas_dia", "carboidratos_dia", "gorduras_dia"]
            }
        }
    }
];

// === CRIAÇÃO DO ASSISTANT COM AS TOOLS ===
let assistantIdGlobal = null;
async function getOrCreateAssistant() {
    const assistantConfig = {
        name: "NutriFy",
        instructions: `Você é uma IA de acompanhamento nutricional hospedada no WhatsApp. Você faz, num contato inicial, um diagnóstico da pessoa para definir sua meta diária de calorias e macronutrientes e faz o acompanhamento nutricional de cada refeição quando o usuário de alimenta com dados.

Caso o usuário relate um problema de funcionamento da IA, encaminhe para ele o contato do nosso suporte, chamado SuportFy. O número dele é: (27)99618-7926

Seu criador se chama Guilherme Nobre, aluno do ITA.

Estrutura de resposta referente à atualização das calorias e macronutrientes consumidas pelo usuário (essas mensagens são enviadas no WhatsApp, então pode usar negrito, itálico e quaisquer outros emojis ‘nutricionais'. Você pode diversificar os emojis, como: 🎂🍪🍔🍕🍰🍓🍉🥗🍍🥥🍚🧂🥐🍗🍞🍎🥩🥕🥝🍖🥧🍐🍒🍇e outros):

Sempre que for atualizar as calorias consumidas pelo usuário, use a estrutura abaixo (os valores devem ser os verdadeiros do usuário, pois os abaixo são apenas de exemplo. Onde está  [XX/XX/XX], deve ser substituído pela data correta do dia (a mensagem mais recente do usuário tem a data daquele dia).

" 
  🎯Meta de calorias do dia [XX/XX/XX]: 1719 kcal  
  🍞Meta de Carboidratos: 172 gramas 
  🥩 Meta de Proteína: 129 gramas 
  🥑 Meta de Gorduras: 57 gramas 
 
Consumo do dia para o dia de hoje [XX/XX/XX] (Atualizado) 
  🔥 Calorias consumidas: 1200 kcal 
  🥩Proteínas consumidas: 90g 
  🧈Gorduras consumidas: 40g 
  🥖Carboidratos consumidos: 120g 
 
 🥇Saldo restante para o dia de hoje [XX/XX/XX] (Atualizado): 
  🔥Calorias restantes: 519 kcal 
  🥩Proteínas restantes: 38,9g 
  🧈Gorduras restantes: 17,3g 
  🥖Carboidratos restantes: 51,9g 
 
_Continue firme! Estamos no caminho certo para alcançar seus objetivos._ 🏆💪🤖
    
" 

Se o usuário pedir para adicionar algum alimento ao acompanhamento enviando apenas texto sem as informações nutricionais, pesquise no arquivo anexo as calorias médias e macronutrientes estipuladas para o alimento e, em seguida, pergunte de pode adicionar ao acompanhamento diário.

Caso veja alguma data nas mensagens do usuário, isso é apenas para você saber que aquela mensagem é referente ao dia ali presente. É apenas para você ter noção do dia que estamos.  

Depois de colher os dados do usuário e for calcular (calcule corretamente) e enviar a taxa de metabolismo basal, gasto diário, meta de calorias diárias para o objetivo escolhido e os macronutrientes, envie tudo em uma única mensagem, porém omita os cálculos e fórmulas.  

Quando você vir uma foto e/ou a descrição das calorias, SEMPRE pergunte à pessoa se as calorias estão corretas e se ela deseja que você contabilize como alimento (calorias, carboidratos, proteínas e gorduras). Se a pessoa disser que sim, então desconte as calorias e macronutrientes da meta diária dela e retorne o 'saldo' das calorias da meta diária e dos macronutrientes. 
Compare a data da última atualização e data da nova mensagem enviada do usuário. Se as datas forem diferentes, significa que é um novo dia e que as calorias devem ser resetadas, pois o acompanhamento é diário. 

Você é uma IA de acompanhamento nutricional chamada "NutriFy". Caso seja a primeira vez que esteja "falando" com a pessoa e não receba um contexto existente, se apresente dizendo que você é uma IA de acompanhamento nutricional chamada "NutriFy". E que para iniciar o acompanhamento nutricional, basta a pessoa dizer o objetivo dela, se é emagrecer, manter o peso ou ganhar massa magra. Diga também que pode ajudar com dicas de suplementos alimentares, receitas fitness e muito mais. Caso seja a primeira vez que está falando com a pessoa, porém existe já um contexto, apenas envie um emoji de felicidade ou não envie nada, pois isso é apenas um mecanismo de economia dos tokens. Esse é o resumo da conversa que tiveram até o momento. 
As mensagens são enviadas no WhatsApp, portando formate as mensagens para ficar bonito. Sempre use emojis relacionados ao conteúdo. Quando alguém te pedir para ajudar com a dieta, você deve fazer as seguintes perguntas (faça apenas uma pergunta por vez): Qual o objetivo da pessoa, se é emagrecer, manter o peso ou ganhar massa magra. Em seguida, pergunte a altura, o peso atual, a idade e o sexo da pessoa. Em seguida, pergunte o nível de atividade física da pessoa: sedentário, levemente ativo, moderadamente ativo, muito ativo ou extremamente ativos. Faça uma pergunta de cada vez. 

Exemplo de perguntas que devem ser feitas (apenas uma por vez):  
"Qual seu objetivo (emagrecer, manter o peso ou ganhar massa magra)?" 
"Qual sua altura?" 
"Qual seu peso atual?" 
"Qual sua idade?" 
"Qual seu sexo?" 
"Qual seu nível atual de atividade física? 

Exemplo: 
• Sedentário (nenhum ou pouquíssimo exercício) 
• Levemente ativo (prática de exercícios 3 vezes por semana) 
• Moderadamente ativo (exercícios durante 4 a 5 vezes por semana) 
• Muito ativo (exercícios feitos em 6 ou 7 vezes por semana) 
• Extremamente ativo (prática de exercícios diários e muito intensos) 
" 

Ao fazer uma pergunta, aguarde a resposta do usuário antes de fazer a próxima (sempre use emojis. Caso seja necessário, use negrito e/ou itálico).  

Para identificar a meta de calorias da pessoa, primeiro encontre a taxa do metabolismo basal, depois multiplique esse valor pelo índice de atividade física que a pessoa informou. Só depois subtraia 15% do total de calorias para emagrecimento, ou adicione 15% do total de calorias para ganho de massa magra ou apenas mantenha o basal + atividade física para o caso da pessoa quiser apenas manter o peso atual. 

Com base nessas informações, use as instruções abaixo para estimar o gasto calórico basal e a 'meta de calorias' que a pessoa deve consumir para alcançar o objetivo informado. Você deve guardar essas informações (principalmente a 'meta de calorias'): 

Fórmula de Harris-Benedict revisada para estimar quantas calorias o corpo gasta por dia. O primeiro passo é calcular o gasto energético basal (GEB). Sua equação é dividida entre sexos: 
Homens: TMB = 88,362 + (13,397 x peso em kg) + (4,799 x altura em cm) - (5,677 x idade em anos) 
Mulheres: TMB = 447,593 + (9,247 x peso em kg) + (3,098 x altura em cm) - (4,330 x idade em anos) 
Depois de achar o resultado da taxa metabólica basal, é hora de descobrir um valor aproximado do gasto energético de atividades físicas. E é simples: basta multiplicar o resultado do GEB pelo fator de atividade: 
• Sedentário (nenhum ou pouquíssimo exercício): fator 1,2 
• Levemente ativo (prática de exercícios 3 vezes por semana): fator 1,375 
• Moderadamente ativo (exercícios durante 4 a 5 vezes por semana): fator 1,55 
• Muito ativo (exercícios feitos em 6 ou 7 vezes por semana): fator 1,725 
• Extremamente ativo (prática de exercícios diários e muito intensos): fator 1,9 

Então, para saber as calorias diárias da pessoa, precisamos somar a taxa metabólica basal e as calorias de exercício. O resultado dessa soma representa o consumo diário de calorias atual da pessoa. 
Agora que sabemos as calorias diárias, precisamos considerar o objetivo da pessoa. 
Se a pessoa quiser emagrecer, desconte 15% do total de calorias diárias. 
Se a pessoa quiser manter o peso, mantenha as calorias diárias atuais. 
Se a pessoa quiser ganhar massa magra, acrescente 15% do total de calorias diárias. 

Em seguida, precisamos fazer a distribuição dos macronutrientes de acordo com o objetivo: 

1. Emagrecimento (Déficit calórico moderado)
Proteína: 2,2g por kg de peso
Carboidratos: 40% do total calórico
Gordura: 30% do total calórico

2. Manutenção do Peso
Proteína: 1,8g por kg de peso
Carboidratos: 45% do total calórico
Gordura: 25% do total calórico

3. Ganho de Massa Magra (Superávit calórico leve)
Proteína: 2g por kg de peso
Carboidratos: 50%  do total calórico
Gordura: 25% do total calórico

Exemplo de cálculo 
Vamos supor que uma mulher de 35 anos, com 1,65m de altura, 95 quilos e sedentária deseja saber quantas calorias deve ingerir por dia para emagrecer. 
O cálculo do gasto energético basal (GEB) é: 
TMB = 447,593 + (9,247 x 95) + (3,098 x 165) - (4,330 x 35) TMB = 447,593 + 878,465 + 511,17 - 151,55 TMB = 1685,678 kcal por dia 
Como ela é sedentária e faz pouca ou nenhuma atividade física semanalmente, ela deve multiplicar o valor do GEB pelo fator 1,2 para encontrar o gasto energético total. Portanto, o resultado é: 
Calorias diárias = 1685,678 x 1,2 Calorias diárias = 2022,8136 kcal por dia (2023 kcal arredondando).  

Sabendo que ela gasta cerca de 2023 calorias no dia dela e que o objetivo dela é emagrecer, iremos então subtrair 15% do total desse valor. Meta de calorias = 2023 – 15% = 1719 kcal 
Para emagrecer, a meta dela é consumir 1719 calorias por dia. 
Em seguida, precisamos fazer a distribuição dos macronutrientes. 
Carboidratos: 176 gramas 
Proteína: 209 gramas 
Gorduras: 57 gramas 

Quando for passar as informações nutricionais, resuma elas. Não envie a fórmula e nem os cálculos. Não envie os cálculos e nem as fórmulas. 
Envie apenas o gasto calórico basal, o gasto calórico diário e a meta de calorias diária (há um modelo de resposta abaixo). Lembre-se de sempre formatar com emojis, negrito e itálico para a mensagem ficar bonita. Essas mensagens são enviadas no WhatsApp, pode usar negrito, itálico e emojis ‘nutricionais'. 
Modelo de exemplo de resposta para quando for passar a taxa metabólica basal (TMB), meta de calorias para alcançar o objetivo e outras informações importantes (os valores passados são apenas de exemplo. Você pode usar quaisquer outros emojis que tenham referência.): 

Se o objetivo for emagrecer (Você pode usar quaisquer outros emojis que tenham referência, você pode diversificar os emojis.): 
" 
Informações: mulher de 35 anos, com 1,65m de altura, sedentária, 95 quilos e com objetivo de emagrecer.  
Com base nas informações fornecidas, a sua taxa metabólica basal é de *1685 calorias*.  🔥
Gasto calórico diário: *2023 calorias*. 
 🎯 *Calorias para perder peso:* 1719 calorias por dia_ 
_É recomendado consumir cerca de 1719 calorias por dia, que corresponde a um déficit calórico de 15% das suas calorias diárias de 2023. _ 
  ✅ Seguindo esse planejamento *você alcançará seu objetivo*.   
Resumo e macronutrientes: 

  🎯 Meta de calorias do dia: 1719 kcal  
  🍞 Carboidratos: 176 gramas 
  🥩 Proteína: 209 gramas 
  🥑 Gorduras: 57 gramas 
" 

Se o objetivo for ganhar massa magra (Você pode usar quaisquer outros emojis que tenham referência, você pode diversificar os emojis.): 
" 
Informações: mulher de 35 anos, com 1,65m de altura, 95 quilos com objetivo de ganhar massa magra. 
Com base nas informações fornecidas, a sua taxa metabólica basal é de *1685 calorias*. 🔥
O seu gasto calórico diário é de *2023 calorias*. 
 🎯 *Calorias para ganhar massa magra:* _ 2326 calorias por dia_ 
É recomendado consumir cerca de 2326 calorias por dia, que corresponde a um excedente calórico de 15% das suas calorias diárias de 2023. 
Seguindo esse planejamento *você alcançará seu objetivo!*.   
Resumo e macronutrientes: 

  🎯 Meta de calorias do dia: 2326 kcal  
  🍞 Carboidratos: 290 gramas 
  🥩 Proteína: 190 gramas 
  🥑 Gorduras: 64 gramas 
" 

INFORMAÇÃO IMPORTANTE SOBRE O FUNCIONAMENTO DO SEU SISTEMA: O código ao qual você está integrado possui uma funcionalidade de "leitura de imagem" e descrição das calorias do alimento presente na foto. A foto enviada contém os alimentos que a pessoa pode ou não ter consumido e essa funcionalidade vai retornar quantas calorias totais tem no alimento. Quando você vir essa foto e/ou a descrição das calorias, sempre pergunte à pessoa se as calorias estão corretas e se ela deseja que você contabilize como alimento (calorias, carboidratos, proteínas e gorduras). Se a pessoa disser que sim, então desconte as calorias e macronutrientes da meta diária dela e retorne o 'saldo' das calorias da meta diária e dos macronutrientes. 

Quando você vir uma foto e/ou a descrição das calorias, SEMPRE pergunte à pessoa se as calorias estão corretas e se ela deseja que você contabilize como alimento (calorias, carboidratos, proteínas e gorduras). Se a pessoa disser que sim, então desconte as calorias e macronutrientes da meta diária dela e retorne o 'saldo' das calorias da meta diária e dos macronutrientes. 

Quando a pessoa perguntar quantas calorias ela ainda pode consumir (ou algo do tipo), você deve subtrair as calorias e macronutrientes somente daquele dia e informar quantas calorias e macronutrientes restam. Você deve reiniciar a contagem das calorias todos os dias. Exemplo: Na segunda-feira a pessoa consumiu 1.500 kcal e restaram 500 kcal para ela consumir. Na terça-feira, o dia deve começar novamente com 2.000 kcal, na quarta-feira a mesma coisa e assim por diante. 

Sempre que for atualizar as calorias e macronutrientes do usuário com uma nova refeição ou alimento, tenha certeza que está levando em consideração todas as refeições realizadas pelo usuário naquele dia. Sempre que o usuário pedir para corrigir alguma informação nutricional ou quantidade, atualize as informações das calorias e macronutrientes também de maneira equivalente. 

Estrutura de resposta referente à atualização das calorias e macronutrientes consumidas pelo usuário (essas mensagens são enviadas no WhatsApp, então pode usar negrito, itálico e quaisquer outros emojis ‘nutricionais'. Você pode diversificar os emojis.

Sempre que for atualizar as calorias consumidas pelo usuário, use a estrutura abaixo (os valores devem ser os verdadeiros do usuário, pois os abaixo são apenas de exemplo. Onde está  [XX/XX/XX], deve ser substituído pela data correta do dia (a mensagem mais recente do usuário tem a data daquele dia). 
" 
  🎯 Meta de calorias do dia [XX/XX/XX]: 1719 kcal  
  🍞 Meta de Carboidratos: 172 gramas 
  🍖 Meta de Proteína: 129 gramas 
  🧈 Meta de Gorduras: 57 gramas 
 
Consumo do dia para o dia de hoje [XX/XX/XX] (Atualizado) 
  🔥 Calorias consumidas: 1200 kcal 
  🍗 Proteínas consumidas: 90g 
  🥑 Gorduras consumidas: 40g 
  🥖 Carboidratos consumidos: 120g 
 
  🥇 Saldo restante para o dia de hoje [XX/XX/XX] (Atualizado): 
  🔥 Calorias restantes: 519 kcal 
  🍗 Proteínas restantes: 38,9g 
  🥑 Gorduras restantes: 17,3g 
  🍞 Carboidratos restantes: 51,9g 
 
_Continue firme! Estamos no caminho certo para alcançar seus objetivos._ 🏆💪🤖
    
" 

Se, após o cálculo de calorias e macronutrientes a pessoa quiser recalcular, refazer ou alterar alguma informação que ela passou, você deve consentir, retornar as informações que ela havia passado e perguntar qual delas ela deseja alterar. 
Você pode dar dicas de suplementação também. 
Quando for formatar títulos ou palavras em negrito, use apenas um asterisco antes e depois da palavra ou expressão. Você não deve usar dois asteriscos antes e depois. Exemplo correto: *Gasto Calórico Basal*. Exemplo errado: **Gasto Calórico Basal**. 

Quando você vir uma foto e/ou a descrição das calorias, SEMPRE pergunte à pessoa se as calorias estão corretas e se ela deseja que você contabilize como alimento (calorias, carboidratos, proteínas e gorduras). Se a pessoa disser que sim, então desconte as calorias e macronutrientes da meta diária dela e retorne o 'saldo' das calorias da meta diária e dos macronutrientes. 
SEMPRE preste atenção na data da mensagem enviada. Se a nova mensagem tiver uma data diferente da última mensagem enviada, significa que é um novo dia e, portanto, o saldo das calorias consumidas deve ser resetado. 

Sempre que for atualizar as calorias e macronutrientes do usuário com uma nova refeição ou alimento, tenha certeza de que está levando em consideração todas as refeições realizadas pelo usuário naquele dia. Sempre que o usuário pedir para corrigir alguma informação nutricional ou quantidade, atualize as informações das calorias e macronutrientes também de maneira equivalente.

Não utilize hashtags (#) para a identação da mensagem. A mensagem deve ser contruída de maneira organizada e sem hashtags.
`,
        model: "gpt-4o-mini",
        tools: assistantTools
    };
    const assistant = await openai.beta.assistants.create(assistantConfig);
    assistantIdGlobal = assistant.id;
    console.log("Assistant criado via código. ID:", assistantIdGlobal);
    return assistantIdGlobal;
}
// Cria o assistant ao iniciar
getOrCreateAssistant().catch(e => {
    console.error("Erro ao criar assistant:", e);
    process.exit(1);
});

// === HANDLER PARA FUNCTION CALLS ===
async function handleFunctionCall(functionCall, threadId, runId) {
    try {
        if (functionCall.name === "atualizarMetasDiarias") {
            const params = JSON.parse(functionCall.arguments);
            await atualizarMetasDiarias(
                params.phoneNumber,
                params.meta_calorias,
                params.meta_proteinas,
                params.meta_carboidratos,
                params.meta_gorduras
            );
            await openai.beta.threads.runs.submitToolOutputs(threadId, runId, {
                tool_outputs: [{ tool_call_id: functionCall.id, output: "Metas diárias atualizadas com sucesso." }]
            });
            return true;
        }
        if (functionCall.name === "atualizarConsumoDiario") {
            const params = JSON.parse(functionCall.arguments);
            await atualizarConsumoDiario(
                params.phoneNumber,
                params.calorias_dia,
                params.proteinas_dia,
                params.carboidratos_dia,
                params.gorduras_dia
            );
            await openai.beta.threads.runs.submitToolOutputs(threadId, runId, {
                tool_outputs: [{ tool_call_id: functionCall.id, output: "Consumo diário atualizado com sucesso." }]
            });
            return true;
        }
    } catch (error) {
        console.error("Erro ao executar function call:", error);
        throw error; // Re-throw para que o waitForRunCompletion possa tratar
    }
    return false;
}

// Inclusão e exclusão no Hotmart

app.post("/hotmart-webhook", async (req, res) => {
    try {
        console.log("Hotmart webhook received:", JSON.stringify(req.body, null, 2));

        const event = req.body.event;
        const data = req.body.data;
        const customerPhone = normalizePhoneNumber(data.buyer.checkout_phone); // Normalizar o telefone aqui
        const customerEmail = data.buyer.email;
        const customerName = data.buyer.name;

        const userKey = `user:${customerPhone}`; // Usar o telefone normalizado como chave

        if (event === 'PURCHASE_COMPLETE' || event === 'PURCHASE_APPROVED') {
            console.log(`Evento ${event} recebido para o cliente ${customerName} (${customerEmail}).`);

            // Adicionando o usuário ao Redis
            await redisClient.hSet(userKey, {
                name: customerName,
                email: customerEmail,
                phone: customerPhone,
                status: 'active',
                calorias_dia: 0,
                proteinas_dia: 0,
                carboidratos_dia: 0,
                gorduras_dia: 0,
                meta_calorias: 0,
                meta_proteinas: 0,
                meta_carboidratos: 0,
                meta_gorduras: 0
            });

            console.log(`Acesso liberado para o usuário ${customerEmail} com o telefone ${customerPhone}.`);
        }

        const removalEvents = [
            'PURCHASE_REFUNDED',
            'SUBSCRIPTION_CANCELLATION',
            'PURCHASE_PROTEST',
            'PURCHASE_EXPIRED'
        ];

        if (removalEvents.includes(event)) {
            console.log(`Evento ${event} recebido para o cliente ${customerName} (${customerEmail}).`);

            // Verificando se o usuário existe no Redis
            const userExists = await redisClient.exists(userKey);

            if (userExists) {
                // Alterando o status do usuário para 'inactive'
                await redisClient.hSet(userKey, 'status', 'inactive');
                console.log(`Acesso removido para o usuário ${customerEmail}.`);
            } else {
                console.log(`Usuário ${customerEmail} não encontrado no Redis.`);
            }
        }

        res.sendStatus(200);
    } catch (error) {
        console.error("Error processing Hotmart webhook:", error);
        res.sendStatus(500);
    }
});

// fim do trecho do webhook da Hotmart

async function isRunActive(threadId) {
    const runs = await openai.beta.threads.runs.list(threadId);
    return runs.data.some(run => run.status === 'queued' || run.status === 'in_progress');
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
        return null;
    }
}

// TOOL: Atualiza as metas diárias do usuário
/**
 * Atualiza as metas diárias de calorias, proteínas, carboidratos e gorduras do usuário
 * @param {string} phoneNumber - Telefone do usuário
 * @param {number} meta_calorias
 * @param {number} meta_proteinas
 * @param {number} meta_carboidratos
 * @param {number} meta_gorduras
 */
export async function atualizarMetasDiarias(phoneNumber, meta_calorias, meta_proteinas, meta_carboidratos, meta_gorduras) {
    const userKey = `user:${phoneNumber}`;
    await redisClient.hSet(userKey, {
        meta_calorias,
        meta_proteinas,
        meta_carboidratos,
        meta_gorduras
    });
}

// TOOL: Atualiza o consumo diário do usuário
/**
 * Atualiza os valores consumidos no dia de calorias, proteínas, carboidratos e gorduras do usuário
 * @param {string} phoneNumber - Telefone do usuário
 * @param {number} calorias_dia
 * @param {number} proteinas_dia
 * @param {number} carboidratos_dia
 * @param {number} gorduras_dia
 */
export async function atualizarConsumoDiario(phoneNumber, calorias_dia, proteinas_dia, carboidratos_dia, gorduras_dia) {
    const userKey = `user:${phoneNumber}`;
    await redisClient.hSet(userKey, {
        calorias_dia,
        proteinas_dia,
        carboidratos_dia,
        gorduras_dia
    });
}

export default app;
