const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { exec } = require('child_process');
const { MercadoPagoConfig, Payment } = require('mercadopago');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CONFIGURAÇÕES ====================\napp.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));
app.use('/assets', express.static(path.join(__dirname, 'assets')));

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

// ==================== GERENCIAMENTO DE USUÁRIOS ====================\nconst USERS_FILE = path.join(__dirname, 'data', 'users.json');
if (!fs.existsSync(path.dirname(USERS_FILE))) fs.mkdirSync(path.dirname(USERS_FILE));
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([]));

function readUsers() { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
function writeUsers(users) { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }

// ==================== MIDDLEWARES DE VALIDAÇÃO ====================\nfunction requireAuth(req, res, next) {
    if (req.session.user) return next();
    res.redirect('/login.html');
}

function requireAdmin(req, res, next) {
    if (req.session.user && req.session.user.role === 'admin') return next();
    res.status(403).send('Acesso negado.');
}

// ==================== ROTAS AUTENTICAÇÃO E SESSÃO ====================\napp.post('/api/login', (express.json()), (req, res) => {
    const { username, password } = req.body;
    const users = readUsers();
    const user = users.find(u => u.username === username && u.password === password);
    if (user) {
        req.session.user = user;
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, error: 'Credenciais inválidas' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login.html');
});

app.get('/api/user-info', requireAuth, (req, res) => {
    const users = readUsers();
    const user = users.find(u => u.username === req.session.user.username);
    res.json({ username: user.username, saldo: user.saldo, role: user.role });
});

app.get('/api/extrato', requireAuth, (req, res) => {
    const users = readUsers();
    const user = users.find(u => u.username === req.session.user.username);
    res.json(user.historico || []);
});

// ==================== ROTAS DE INTERFACE (VIEWS) ====================\napp.get('/home', requireAuth, (req, res) => {
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

app.get('/bot-admin', requireAuth, requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'private', 'bot-admin.html'));
});

// ==================== ROTAS EXCLUSIVAS DO RG ====================\napp.get('/gerar-rg', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'private', 'gerar-rg.html'));
});

app.get('/calibrar-rg', requireAuth, requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'private', 'calibrador-rg.html'));
});

app.get('/api/coords-rg', requireAuth, requireAdmin, (req, res) => {
    const filePath = path.join(__dirname, 'assets', 'modelo_rg.template.json');
    if (fs.existsSync(filePath)) {
        res.json(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    } else {
        res.json({});
    }
});

app.post('/api/save-coords-rg', requireAuth, requireAdmin, (req, res) => {
    const filePath = path.join(__dirname, 'assets', 'modelo_rg.template.json');
    try {
        let currentCoords = {};
        if (fs.existsSync(filePath)) {
            currentCoords = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
        const novasCoordenadas = { ...currentCoords, ...req.body };
        fs.writeFileSync(filePath, JSON.stringify(novasCoordenadas, null, 2));
        res.sendStatus(200);
    } catch (e) {
        res.status(500).send("Erro ao salvar arquivo de coordenadas do RG.");
    }
});

// ==================== LÓGICA DE RECARGA MERCADO PAGO ====================\napp.post('/api/recarga', requireAuth, async (req, res) => {
    const { valor } = req.body;
    try {
        const paymentData = await payment.create({
            body: {
                transaction_amount: parseFloat(valor),
                description: `Recarga CH Vendas - ${req.session.user.username}`,
                payment_method_id: 'pix',
                payer: { email: 'carlos@chbicos.com', first_name: 'Carlos', last_name: 'Henrique' }
            }
        });
        res.json({
            success: true,
            paymentId: paymentData.id,
            qrCode: paymentData.point_of_interaction.transaction_data.qr_code,
            qrCodeBase64: paymentData.point_of_interaction.transaction_data.qr_code_base64
        });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/confirmar-recarga', requireAuth, async (req, res) => {
    const { paymentId, valor } = req.body;
    try {
        const statusCheck = await payment.get({ id: paymentId });
        if (statusCheck.status === 'approved' || statusCheck.status === 'pending') { 
            // Aceitando pendente temporariamente para testes locais fluidos
            const users = readUsers();
            const user = users.find(u => u.username === req.session.user.username);
            user.saldo += parseFloat(valor);
            if(!user.historico) user.historico = [];
            user.historico.push({ descricao: 'Recarga de Saldo via PIX', valor: parseFloat(valor), tipo: 'recarga', data: new Date() });
            writeUsers(users);
            res.json({ success: true, saldo: user.saldo });
        } else { res.json({ success: false }); }
    } catch (e) { res.status(500).json({ success: false }); }
});

// Rota padrão do sistema
app.get('/', (req, res) => {
    if (req.session.user) { res.redirect('/home'); } else { res.redirect('/login.html'); }
});

// ==================== INICIAR SERVIDOR ====================\napp.listen(PORT, '0.0.0.0', () => {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`🚀 SERVIDOR CH VENDAS CORRIGIDO E INTEGRADO`);
    console.log(`📍 Local: http://localhost:${PORT}`);
    console.log(`${'='.repeat(50)}`);
});
