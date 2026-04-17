const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { exec } = require('child_process');
const { MercadoPagoConfig, Payment } = require('mercadopago');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CONFIGURAÇÕES ====================
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

app.use(session({
    secret: process.env.SESSION_SECRET || 'ch-contas-secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// Configurar Mercado Pago
const client = new MercadoPagoConfig({
    accessToken: 'APP_USR-6089853392725639-040723-b9b1f076c942da11f2a006271503d5a2-2949958903'
});
const payment = new Payment(client);

// URL do bot via ngrok (atualize quando reiniciar o ngrok)
const BOT_API_URL = 'http://localhost:3001';
const VPS_API_URL = 'http://localhost:5000';

// ==================== MIDDLEWARES ====================
const requireAuth = (req, res, next) => {
    if (req.session.user) {
        next();
    } else {
        res.redirect('/login.html');
    }
};

const requireAdmin = (req, res, next) => {
    if (req.session.role === 'admin') {
        next();
    } else {
        res.status(403).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <script>
                    alert('⛔ ACESSO NEGADO! Apenas administradores chefes podem acessar esta área.');
                    window.location.href = '/home';
                </script>
            </head>
            <body></body>
            </html>
        `);
    }
};

// ==================== GERENCIAMENTO DE USUÁRIOS ====================
const USERS_FILE = path.join(__dirname, 'data', 'users.json');

if (!fs.existsSync(path.join(__dirname, 'data'))) {
    fs.mkdirSync(path.join(__dirname, 'data'));
}

const defaultUsers = [
    { id: 1, user: 'Newbr47', pass: '88837024', role: 'admin', nome: 'Carlos Henrique', plano: 'MASTER PREMIUM', createdAt: new Date().toISOString(), saldo: 100 },
    { id: 2, user: 'chcontas', pass: 'master2026', role: 'user', nome: 'CH Contas', plano: 'OPERADOR', createdAt: new Date().toISOString(), saldo: 50 }
];

function loadUsers() {
    if (!fs.existsSync(USERS_FILE)) {
        fs.writeFileSync(USERS_FILE, JSON.stringify(defaultUsers, null, 2));
        return defaultUsers;
    }
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}

function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// API de usuários
app.get('/api/usuarios', requireAuth, requireAdmin, (req, res) => {
    const users = loadUsers();
    const safeUsers = users.map(u => ({ ...u, pass: '********' }));
    res.json(safeUsers);
});

app.post('/api/usuarios', requireAuth, requireAdmin, (req, res) => {
    const { user, pass, role, nome, saldo } = req.body;
    if (!user || !pass) {
        return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
    }
    const users = loadUsers();
    if (users.find(u => u.user === user)) {
        return res.status(400).json({ error: 'Usuário já existe!' });
    }
    const newUser = {
        id: users.length + 1,
        user: user,
        pass: pass,
        role: role || 'user',
        nome: nome || user,
        plano: role === 'admin' ? 'MASTER PREMIUM' : 'OPERADOR',
        createdAt: new Date().toISOString(),
        saldo: saldo || 0
    };
    users.push(newUser);
    saveUsers(users);
    res.json({ success: true, user: { ...newUser, pass: '********' } });
});

app.put('/api/usuarios/:id', requireAuth, requireAdmin, (req, res) => {
    const { id } = req.params;
    const { user, pass, role, nome, saldo } = req.body;
    const users = loadUsers();
    const index = users.findIndex(u => u.id == id);
    if (index === -1) {
        return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    users[index].user = user || users[index].user;
    if (pass) users[index].pass = pass;
    users[index].role = role || users[index].role;
    users[index].nome = nome || users[index].nome;
    users[index].plano = users[index].role === 'admin' ? 'MASTER PREMIUM' : 'OPERADOR';
    if (saldo !== undefined) users[index].saldo = saldo;
    saveUsers(users);
    res.json({ success: true, user: { ...users[index], pass: '********' } });
});

app.delete('/api/usuarios/:id', requireAuth, requireAdmin, (req, res) => {
    const { id } = req.params;
    const users = loadUsers();
    if (users.find(u => u.id == id && u.user === req.session.user)) {
        return res.status(400).json({ error: 'Você não pode deletar seu próprio usuário!' });
    }
    const filteredUsers = users.filter(u => u.id != id);
    if (filteredUsers.length === users.length) {
        return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    saveUsers(filteredUsers);
    res.json({ success: true });
});

// ==================== ROTAS PÚBLICAS ====================
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const users = loadUsers();
    const usuarioValido = users.find(u => u.user === username && u.pass === password);
    if (usuarioValido) {
        req.session.user = usuarioValido.user;
        req.session.nome = usuarioValido.nome;
        req.session.role = usuarioValido.role;
        req.session.plano = usuarioValido.plano;
        req.session.userId = usuarioValido.id;
        res.redirect('/home');
    } else {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <script>
                    alert('❌ Acesso negado! Credenciais inválidas.');
                    window.location.href = '/login.html';
                </script>
            </head>
            <body></body>
            </html>
        `);
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login.html');
});

// ==================== API DE SESSÃO ====================
app.get('/api/session', requireAuth, (req, res) => {
    const users = loadUsers();
    const user = users.find(u => u.user === req.session.user);
    res.json({
        user: req.session.user,
        nome: req.session.nome,
        role: req.session.role,
        plano: req.session.plano,
        userId: req.session.userId,
        saldo: user?.saldo || 0,
        expira: "08/05/2026 01:48:55"
    });
});

// ==================== API DO MINI APP (LOJA DE BICOS) ====================

// Rota para comparar foto (proxy para o worker)
app.post('/api/compare', async (req, res) => {
    const { imagem, categoria } = req.body;
    
    try {
        // Converter base64 para buffer
        const base64Data = imagem.split(',')[1];
        const buffer = Buffer.from(base64Data, 'base64');
        
        // Chamar o worker facial
        const response = await fetch('http://127.0.0.1:5000/compare_protected', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/octet-stream',
                'categoria': categoria
            },
            body: buffer
        });
        
        const data = await response.json();
        res.json(data);
    } catch (err) {
        console.error('Erro ao comparar foto:', err);
        res.status(500).json({ error: err.message });
    }
});

// Saldo do usuário
app.get('/api/user/saldo', requireAuth, (req, res) => {
    const users = loadUsers();
    const user = users.find(u => u.id === req.session.userId);
    res.json({ saldo: user?.saldo || 0 });
});

// Comprar com saldo
app.post('/api/comprar/saldo', requireAuth, async (req, res) => {
    const { bicoId, valor } = req.body;
    const users = loadUsers();
    const userIndex = users.findIndex(u => u.id === req.session.userId);
    
    if (userIndex === -1) {
        return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    if (users[userIndex].saldo < valor) {
        return res.json({ success: false, error: 'Saldo insuficiente' });
    }
    
    // Debitar saldo
    users[userIndex].saldo -= valor;
    saveUsers(users);
    
    // Buscar dados do BICO (simulado)
    const dadosBico = "CPF: 123.456.789-00\nCNH: 12345678900\nData Nasc: 01/01/1990\nEndereço: Rua Exemplo, 123";
    
    res.json({ 
        success: true, 
        dados: dadosBico,
        saldo: users[userIndex].saldo
    });
});

// Gerar PIX para compra
app.post('/api/comprar/pix', requireAuth, async (req, res) => {
    const { valor, descricao } = req.body;
    
    try {
        const response = await payment.create({
            body: {
                transaction_amount: Number(valor),
                description: descricao || 'Compra de bico',
                payment_method_id: 'pix',
                payer: { email: `${req.session.userId}@chvendas.com.br` }
            }
        });
        
        res.json({
            success: true,
            transactionId: response.id,
            qrCode: response.point_of_interaction.transaction_data.qr_code_base64,
            pixCode: response.point_of_interaction.transaction_data.qr_code
        });
    } catch (err) {
        console.error('Erro ao gerar PIX:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Confirmar pagamento PIX
app.get('/api/comprar/confirmar-pix/:id', async (req, res) => {
    try {
        const response = await payment.get({ id: req.params.id });
        res.json({ status: response.status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== API CONSULTADOR DE ANTECEDENTES ====================
app.post('/api/consultar-antecedentes', requireAuth, (req, res) => {
    const { cpf, nome } = req.body;
    
    console.log(`[CONSULTA] CPF: ${cpf}, Nome: ${nome}`);
    
    if (!cpf && !nome) {
        return res.status(400).json({ error: 'CPF ou Nome é obrigatório' });
    }
    
    const pythonScript = path.join(__dirname, 'scripts', 'consulta_datajud_robusto.py');
    
    if (!fs.existsSync(pythonScript)) {
        return res.status(500).json({ error: 'Script de consulta não encontrado' });
    }
    
    const cpfLimpo = cpf ? cpf.replace(/\D/g, '') : '';
    
    exec(`python "${pythonScript}" "${cpfLimpo}"`, 
        { timeout: 60000 },
        (error, stdout, stderr) => {
            if (error) {
                console.error('Erro no script:', error);
                return res.status(500).json({ 
                    error: 'Erro ao consultar',
                    details: stderr || error.message
                });
            }
            
            const output = stdout.toString();
            console.log('Python output:', output);
            
            let status = 'pendente';
            let mensagem = '';
            
            if (output.includes('APROVADO')) {
                status = 'aprovado';
                mensagem = '✅ Nada consta na base do CNJ. Motorista aprovado!';
            } else if (output.includes('REPROVADO')) {
                status = 'reprovado';
                mensagem = '❌ Processos encontrados. Motorista reprovado.';
            } else {
                status = 'erro';
                mensagem = '⚠️ Erro na consulta. Tente novamente.';
            }
            
            res.json({ 
                status, 
                mensagem, 
                cpf_consultado: cpfLimpo 
            });
        }
    );
});

// ==================== API DO BOT DE BICOS ====================
const BOT_STATS_FILE = path.join(__dirname, 'data', 'bot_stats.json');

if (!fs.existsSync(BOT_STATS_FILE)) {
    fs.writeFileSync(BOT_STATS_FILE, JSON.stringify({ vendas: 0, total_faturado: 0, ultimas_vendas: [] }));
}

app.get('/api/bot/stats', requireAuth, requireAdmin, (req, res) => {
    const stats = JSON.parse(fs.readFileSync(BOT_STATS_FILE, 'utf8'));
    res.json(stats);
});

app.get('/api/bot-status', requireAuth, async (req, res) => {
    try {
        const response = await fetch(`${BOT_API_URL}/api/bot/status`);
        if (response.ok) {
            const data = await response.json();
            res.json({ status: 'online', ...data });
        } else {
            res.json({ status: 'offline' });
        }
    } catch (error) {
        res.json({ status: 'offline', error: error.message });
    }
});

// ==================== API DE COORDENADAS ====================
app.get('/api/coords', requireAuth, requireAdmin, (req, res) => {
    const tipo = req.query.tipo || 'moto';
    const fileName = tipo === 'carro' ? 'modelo_carro.template.json' : 'modelo_moto.template.json';
    const filePath = path.join(__dirname, 'assets', fileName);
    
    if (fs.existsSync(filePath)) {
        res.json(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    } else {
        res.json({});
    }
});

app.post('/api/save-coords', requireAuth, requireAdmin, (req, res) => {
    const tipo = req.query.tipo || 'moto';
    const fileName = tipo === 'carro' ? 'modelo_carro.template.json' : 'modelo_moto.template.json';
    const assetsPath = path.join(__dirname, 'assets');
    
    if (!fs.existsSync(assetsPath)) fs.mkdirSync(assetsPath);
    
    const filePath = path.join(assetsPath, fileName);
    
    try {
        fs.writeFileSync(filePath, JSON.stringify(req.body, null, 2));
        res.sendStatus(200);
    } catch (e) {
        res.status(500).send("Erro ao salvar arquivo de coordenadas.");
    }
});

// ==================== ROTAS PROTEGIDAS ====================
app.get('/home', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'private', 'home.html'));
});

app.get('/emissao', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'private', 'emissao.html'));
});

app.get('/calibrar', requireAuth, requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'private', 'index.html'));
});

app.get('/usuarios', requireAuth, requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'private', 'usuarios.html'));
});

app.get('/consultador', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'private', 'consultador.html'));
});

app.get('/bicos', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'private', 'bicos.html'));
});

app.get('/bot-admin', requireAuth, requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'private', 'bot-admin.html'));
});

app.get('/chat-bot', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'private', 'chat-bot.html'));
});

// Mini App - Loja de BICOS (pública, sem autenticação)
app.get('/loja', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'loja.html'));
});

// ==================== ROTA DE GERAÇÃO DE PDF ====================
function formatarCpfCnpj(valor) {
    const limpo = valor.replace(/\D/g, '');
    if (limpo.length === 11) {
        return limpo.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
    } else if (limpo.length === 14) {
        return limpo.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
    }
    return valor;
}

app.post('/api/gerar-final', requireAuth, async (req, res) => {
    try {
        const dados = req.body;
        const tipo = dados.tipo_template || dados.tipo_veiculo || 'carro';
        
        const templatePDFName = tipo === 'moto' ? 'template_moto.pdf' : 'template_carro.pdf';
        const coordsJSONName = tipo === 'moto' ? 'modelo_moto.template.json' : 'modelo_carro.template.json';
        
        const pdfPath = path.join(__dirname, 'assets', templatePDFName);
        const coordsPath = path.join(__dirname, 'assets', coordsJSONName);

        if (!fs.existsSync(pdfPath)) {
            return res.status(404).send(`Arquivo PDF base (${templatePDFName}) não encontrado.`);
        }
        if (!fs.existsSync(coordsPath)) {
            return res.status(404).send(`Template de coordenadas (${coordsJSONName}) não encontrado.`);
        }

        const existingPdfBytes = fs.readFileSync(pdfPath);
        const pdfDoc = await PDFDocument.load(existingPdfBytes);
        const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
        const firstPage = pdfDoc.getPages()[0];
        const coords = JSON.parse(fs.readFileSync(coordsPath, 'utf8'));

        Object.keys(coords).forEach(key => {
            const pos = coords[key];
            if (pos.x !== undefined && pos.y !== undefined) {
                const w = parseFloat(pos.w || 150);
                const h = parseFloat(pos.h || 12);
                const yOffset = parseFloat(pos.yOffsetRect || -2);

                firstPage.drawRectangle({
                    x: parseFloat(pos.x),
                    y: parseFloat(pos.y) + yOffset,
                    width: w,
                    height: h,
                    color: rgb(1, 1, 1),
                });
            }
        });

        Object.keys(coords).forEach(key => {
            const pos = coords[key];
            let valor = dados[key] || "";

            if (!valor) {
                if (key === 'numero_crv' && dados.num_crv) valor = dados.num_crv;
                if (key === 'cod_seguranca' && dados.codigo_seguranca) valor = dados.codigo_seguranca;
                if (key === 'data' && dados.data_emissao) valor = dados.data_emissao;
            }

            valor = valor.toString().trim().toUpperCase();
            if (key === 'cpf_cnpj') valor = formatarCpfCnpj(valor);
            
            if (pos.x !== undefined && pos.y !== undefined && valor !== "") {
                const x = parseFloat(pos.x);
                const y = parseFloat(pos.y);
                
                let fontSize = 9;
                if (valor.length > 20) fontSize = 8;
                if (valor.length > 30) fontSize = 7;

                firstPage.drawText(valor, {
                    x: x + parseFloat(pos.offX || 0),
                    y: y,
                    size: fontSize,
                    font: fontBold,
                    color: rgb(0, 0, 0),
                });
            }
        });

        const pdfBuffer = await pdfDoc.save();
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="CRLV_${dados.placa || 'DOCUMENTO'}.pdf"`);
        res.send(Buffer.from(pdfBuffer));

    } catch (error) {
        console.error("Erro crítico:", error);
        res.status(500).send("Erro interno ao processar o documento PDF.");
    }
});

// ==================== ROTA RAIZ ====================
app.get('/', (req, res) => {
    if (req.session.user) {
        res.redirect('/home');
    } else {
        res.redirect('/login.html');
    }
});

// ==================== INICIAR SERVIDOR ====================
app.listen(PORT, () => {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`🚀 SERVIDOR CH VENDAS`);
    console.log(`${'='.repeat(50)}`);
    console.log(`📍 Local: http://localhost:${PORT}`);
    console.log(`🔑 Admin: Newbr47 / 88837024`);
    console.log(`📄 Emissão CRLV: /emissao`);
    console.log(`🔍 Consultador: /consultador`);
    console.log(`👥 Usuários: /usuarios`);
    console.log(`🤖 Bot de Bicos: /bicos`);
    console.log(`💰 Admin Bot: /bot-admin`);
    console.log(`💬 Chat com Bot: /chat-bot`);
    console.log(`🛒 Mini App Loja: /loja`);
    console.log(`${'='.repeat(50)}\n`);
});
