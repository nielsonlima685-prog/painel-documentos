const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { exec } = require('child_process');
const { MercadoPagoConfig, Payment } = require('mercadopago');

const app = express();
const PORT = process.env.PORT || 3000;

// Habilitar proxy para o Render gerenciar os cookies de sessão corretamente
app.set('trust proxy', 1);

// ==================== CONFIGURAÇÕES ====================
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));
app.use('/assets', express.static(path.join(__dirname, 'assets')));

app.use(session({
    secret: process.env.SESSION_SECRET || 'ch-contas-secret-key',
    resave: false,
    saveUninitialized: false, 
    cookie: { 
        maxAge: 24 * 60 * 60 * 1000,
        secure: false, // O Render lida com HTTPS na borda, manter false ajuda na compatibilidade local/deploy
        httpOnly: true
    }
}));

// Configurar Mercado Pago
const client = new MercadoPagoConfig({
    accessToken: 'APP_USR-6089853392725639-040723-b9b1f076c942da11f2a006271503d5a2-2949958903'
});
const payment = new Payment(client);

// ==================== GERENCIAMENTO DE USUÁRIOS ====================
const USERS_FILE = path.join(__dirname, 'data', 'users.json');

if (!fs.existsSync(path.join(__dirname, 'data'))) {
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}

const defaultUsers = [
    { 
        id: 1, 
        user: 'Newbr47', 
        pass: '88837024', 
        role: 'admin', 
        nome: 'Carlos Henrique', 
        plano: 'MASTER PREMIUM', 
        createdAt: new Date().toISOString(), 
        saldo: 100,
        transacoes: []
    }
];

function loadUserData() {
    if (!fs.existsSync(USERS_FILE)) {
        fs.writeFileSync(USERS_FILE, JSON.stringify(defaultUsers, null, 2));
        return defaultUsers;
    }
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}

function saveUserData(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// Inicializa o arquivo de dados na primeira execução
loadUserData();

// ==================== FUNÇÕES DE CARTEIRA ====================
async function debitarSaldo(userId, valor, servico, sessionUser = null) {
    const users = loadUserData();
    const userIndex = users.findIndex(u => u.id == userId);
    
    if (userIndex === -1) {
        throw new Error('Usuário não encontrado');
    }

    // Bypass de cobrança se for o Administrador
    if (users[userIndex].user === 'Newbr47' || sessionUser === 'Newbr47' || users[userIndex].role === 'admin') {
        console.log(`[BYPASS ADM] Ignorando cobrança de R$ ${valor} para o administrador.`);
        if (!users[userIndex].transacoes) users[userIndex].transacoes = [];
        users[userIndex].transacoes.unshift({
            tipo: 'saida',
            servico: `${servico} (Cortesia Admin)`,
            valor: 0,
            data: new Date().toISOString(),
            saldo_apos: users[userIndex].saldo || 0
        });
        saveUserData(users);
        return true;
    }
    
    const saldoAtual = users[userIndex].saldo || 0;
    if (saldoAtual < valor) {
        throw new Error(`Saldo insuficiente. Necessário R$ ${valor.toFixed(2)}`);
    }
    
    users[userIndex].saldo = saldoAtual - valor;
    if (!users[userIndex].transacoes) users[userIndex].transacoes = [];
    users[userIndex].transacoes.unshift({
        tipo: 'saida',
        servico: servico,
        valor: valor,
        data: new Date().toISOString(),
        saldo_apos: users[userIndex].saldo
    });
    
    saveUserData(users);
    return true;
}

async function creditarSaldo(userId, valor, descricao) {
    const users = loadUserData();
    const userIndex = users.findIndex(u => u.id == userId);
    
    if (userIndex === -1) {
        throw new Error('Usuário não encontrado');
    }
    
    users[userIndex].saldo = (users[userIndex].saldo || 0) + valor;
    if (!users[userIndex].transacoes) users[userIndex].transacoes = [];
    users[userIndex].transacoes.unshift({
        tipo: 'entrada',
        servico: descricao,
        valor: valor,
        data: new Date().toISOString(),
        saldo_apos: users[userIndex].saldo
    });
    
    saveUserData(users);
    return true;
}

// ==================== MIDDLEWARES DE VALIDAÇÃO ====================
const requireAuth = (req, res, next) => {
    if (req.session && req.session.user) {
        return next();
    } else {
        if (req.xhr || req.path.startsWith('/api/')) {
            return res.status(401).json({ error: 'Sessão expirada' });
        }
        res.redirect('/login.html');
    }
};

const requireAdmin = (req, res, next) => {
    if (req.session && (req.session.role === 'admin' || req.session.user === 'Newbr47')) {
        return next();
    } else {
        res.status(403).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <script>
                    alert('⛔ ACESSO NEGADO! Apenas administradores podem acessar esta área.');
                    window.location.href = '/home';
                </script>
            </head>
            <body></body>
            </html>
        `);
    }
};

// ==================== ROTAS DE AUTENTICAÇÃO ====================
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const users = loadUserData();
    const usuarioValido = users.find(u => u.user === username && u.pass === password);
    
    if (usuarioValido) {
        req.session.user = usuarioValido.user;
        req.session.nome = usuarioValido.nome;
        req.session.role = usuarioValido.role;
        req.session.plano = usuarioValido.plano;
        req.session.userId = usuarioValido.id;
        
        // Salva explicitamente a sessão antes do redirect para evitar loops no Render
        req.session.save((err) => {
            if (err) {
                console.error("Erro ao salvar sessão:", err);
                return res.status(500).send("Erro interno ao processar login.");
            }
            res.redirect('/home');
        });
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
    req.session.destroy(() => {
        res.redirect('/login.html');
    });
});

// ==================== API DE SESSÃO / INFORMAÇÕES ====================
app.get('/api/user-info', requireAuth, (req, res) => {
    const users = loadUserData();
    const user = users.find(u => u.user === req.session.user);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    res.json({
        username: user.user,
        saldo: user.role === 'admin' ? 999999 : (user.saldo || 0),
        role: user.role
    });
});

app.get('/api/session', requireAuth, (req, res) => {
    const users = loadUserData();
    const user = users.find(u => u.user === req.session.user);
    res.json({
        user: req.session.user,
        nome: req.session.nome,
        role: req.session.role,
        plano: req.session.plano,
        userId: req.session.userId,
        saldo: req.session.role === 'admin' ? 999999 : (user?.saldo || 0),
        expira: "08/05/2026 01:48:55"
    });
});

// ==================== API DE CARTEIRA ====================
app.get('/api/saldo', requireAuth, (req, res) => {
    const users = loadUserData();
    const user = users.find(u => u.id === req.session.userId);
    res.json({ saldo: req.session.role === 'admin' ? 999999 : (user?.saldo || 0) });
});

app.get('/api/extrato', requireAuth, (req, res) => {
    const users = loadUserData();
    const user = users.find(u => u.id === req.session.userId);
    res.json(user ? (user.transacoes || []) : []);
});

// Gerar PIX Mercado Pago
app.post('/api/gerar-recarga', requireAuth, async (req, res) => {
    const { valor } = req.body;
    const userId = req.session.userId;
    
    if (!valor || valor < 10) {
        return res.status(400).json({ error: 'Valor mínimo de R$ 10,00' });
    }
    
    try {
        const response = await payment.create({
            body: {
                transaction_amount: Number(valor),
                description: `Recarga de saldo - CH Vendas`,
                payment_method_id: 'pix',
                payer: { email: `${userId}@chvendas.com.br` }
            }
        });
        
        res.json({
            success: true,
            transactionId: response.id,
            qrCode: response.point_of_interaction.transaction_data.qr_code_base64,
            pixCode: response.point_of_interaction.transaction_data.qr_code,
            valor: valor
        });
    } catch (err) {
        console.error('Erro ao gerar PIX:', err);
        res.status(500).json({ error: err.message });
    }
});

// Confirmar pagamento PIX
app.post('/api/confirmar-recarga', requireAuth, async (req, res) => {
    const { transactionId, valor } = req.body;
    const userId = req.session.userId;
    
    try {
        const response = await payment.get({ id: transactionId });
        
        if (response.body.status === 'approved') {
            await creditarSaldo(userId, valor, `Recarga de R$ ${valor.toFixed(2)}`);
            const users = loadUserData();
            const user = users.find(u => u.id === userId);
            res.json({ success: true, saldo: user?.saldo || 0 });
        } else {
            res.json({ success: false, status: response.body.status });
        }
    } catch (err) {
        console.error('Erro ao confirmar recarga:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== API CONSULTADOR ====================
app.post('/api/consultar-antecedentes', requireAuth, async (req, res) => {
    const { cpf, nome } = req.body;
    const userId = req.session.userId;
    const valorServico = 10;
    
    if (!cpf && !nome) {
        return res.status(400).json({ error: 'CPF ou Nome é obrigatório' });
    }
    
    try {
        await debitarSaldo(userId, valorServico, 'Consulta de antecedentes', req.session.user);
        
        const resultado = {
            status: 'aprovado',
            mensagem: '✅ Nada consta na base de dados. Motorista aprovado!',
            processos: []
        };
        
        res.json(resultado);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ==================== API DE GERAÇÃO DO PDF (CRLV) ====================
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
        const userId = req.session.userId;
        const valorServico = 40;
        
        await debitarSaldo(userId, valorServico, 'Emissão CRLV', req.session.user);
        
        const tipo = dados.tipo_template || dados.tipo_veiculo || 'carro';
        const templatePDFName = tipo === 'moto' ? 'template_moto.pdf' : 'template_carro.pdf';
        const coordsJSONName = tipo === 'moto' ? 'modelo_moto.template.json' : 'modelo_carro.template.json';
        
        const pdfPath = path.join(__dirname, 'assets', templatePDFName);
        const coordsPath = path.join(__dirname, 'assets', coordsJSONName);

        if (!fs.existsSync(pdfPath)) return res.status(404).send(`Arquivo PDF base não encontrado.`);
        if (!fs.existsSync(coordsPath)) return res.status(404).send(`Template de coordenadas não encontrado.`);

        const existingPdfBytes = fs.readFileSync(pdfPath);
        const pdfDoc = await PDFDocument.load(existingPdfBytes);
        const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
        const firstPage = pdfDoc.getPages()[0];
        const coords = JSON.parse(fs.readFileSync(coordsPath, 'utf8'));

        Object.keys(coords).forEach(key => {
            const pos = coords[key];
            if (pos.x !== undefined && pos.y !== undefined) {
                firstPage.drawRectangle({
                    x: parseFloat(pos.x),
                    y: parseFloat(pos.y) + parseFloat(pos.yOffsetRect || -2),
                    width: parseFloat(pos.w || 150),
                    height: parseFloat(pos.h || 12),
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
                let fontSize = 9;
                if (valor.length > 20) fontSize = 8;
                if (valor.length > 30) fontSize = 7;

                firstPage.drawText(valor, {
                    x: parseFloat(pos.x) + parseFloat(pos.offX || 0),
                    y: parseFloat(pos.y),
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
        console.error("Erro crítico CRLV:", error);
        res.status(500).send(error.message);
    }
});

// ==================== ADMIN - GERENCIAR USUÁRIOS ====================
app.get('/api/usuarios', requireAuth, requireAdmin, (req, res) => {
    const users = loadUserData();
    const safeUsers = users.map(u => ({ ...u, pass: '********' }));
    res.json(safeUsers);
});

app.post('/api/usuarios', requireAuth, requireAdmin, (req, res) => {
    const { user, pass, role, nome, saldo } = req.body;
    if (!user || !pass) return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
    
    const users = loadUserData();
    if (users.find(u => u.user === user)) return res.status(400).json({ error: 'Usuário já existe!' });
    
    const newUser = {
        id: users.length + 1,
        user: user,
        pass: pass,
        role: role || 'user',
        nome: nome || user,
        plano: role === 'admin' ? 'MASTER PREMIUM' : 'OPERADOR',
        createdAt: new Date().toISOString(),
        saldo: saldo !== undefined ? Number(saldo) : 0,  
        transacoes: []
    };
    users.push(newUser);
    saveUserData(users);
    res.json({ success: true, user: { ...newUser, pass: '********' } });
});

app.put('/api/usuarios/:id', requireAuth, requireAdmin, (req, res) => {
    const { id } = req.params;
    const { user, pass, role, nome, saldo } = req.body;
    const users = loadUserData();
    const index = users.findIndex(u => u.id == id);
    if (index === -1) return res.status(404).json({ error: 'Usuário não encontrado' });
    
    users[index].user = user || users[index].user;
    if (pass) users[index].pass = pass;
    users[index].role = role || users[index].role;
    users[index].nome = nome || users[index].nome;
    users[index].plano = users[index].role === 'admin' ? 'MASTER PREMIUM' : 'OPERADOR';
    if (saldo !== undefined) users[index].saldo = Number(saldo);
    saveUserData(users);
    res.json({ success: true, user: { ...users[index], pass: '********' } });
});

app.delete('/api/usuarios/:id', requireAuth, requireAdmin, (req, res) => {
    const { id } = req.params;
    const users = loadUserData();
    if (users.find(u => u.id == id && u.user === req.session.user)) {
        return res.status(400).json({ error: 'Você não pode deletar seu próprio usuário!' });
    }
    const filteredUsers = users.filter(u => u.id != id);
    saveUserData(filteredUsers);
    res.json({ success: true });
});

// ==================== API DE MAPAS E COORDENADAS (CRLV) ====================
app.get('/api/coords', requireAuth, requireAdmin, (req, res) => {
    const tipo = req.query.tipo || 'moto';
    
    if (tipo === 'rg') {
        const filePath = path.join(__dirname, 'assets', 'modelo_rg.template.json');
        return res.json(fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : {});
    }

    const filePath = path.join(__dirname, 'assets', tipo === 'carro' ? 'modelo_carro.template.json' : 'modelo_moto.template.json');
    res.json(fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : {});
});

app.post('/api/save-coords', requireAuth, requireAdmin, (req, res) => {
    const tipo = req.query.tipo || 'moto';
    
    if (tipo === 'rg') {
        const filePath = path.join(__dirname, 'assets', 'modelo_rg.template.json');
        try {
            let currentCoords = {};
            if (fs.existsSync(filePath)) currentCoords = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const novasCoordenadas = { ...currentCoords, ...req.body };
            fs.writeFileSync(filePath, JSON.stringify(novasCoordenadas, null, 2));
            return res.sendStatus(200);
        } catch (e) {
            return res.status(500).send("Erro ao salvar coordenadas do RG via rota genérica.");
        }
    }

    const filePath = path.join(__dirname, 'assets', tipo === 'carro' ? 'modelo_carro.template.json' : 'modelo_moto.template.json');
    try {
        let currentCoords = {};
        if (fs.existsSync(filePath)) currentCoords = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const novasCoordenadas = { ...currentCoords, ...req.body };
        fs.writeFileSync(filePath, JSON.stringify(novasCoordenadas, null, 2));
        res.sendStatus(200);
    } catch (e) {
        res.status(500).send("Erro ao salvar coordenadas.");
    }
});

// ==================== ROTAS SEPARADAS E EXCLUSIVAS DO RG & CALIBRADOR ====================

// Rota para o calibrador ler qual PDF renderizar ao fundo
app.get('/api/model-pdf', requireAuth, requireAdmin, (req, res) => {
    const tipo = req.query.tipo || 'moto';
    let fileName = 'template_moto.pdf';

    if (tipo === 'carro') fileName = 'template_carro.pdf';
    if (tipo === 'rg') fileName = 'template_rg.pdf';

    const filePath = path.join(__dirname, 'assets', fileName);

    if (fs.existsSync(filePath)) {
        res.setHeader('Content-Type', 'application/pdf');
        res.sendFile(filePath);
    } else {
        res.status(404).send("Arquivo PDF de modelo não encontrado.");
    }
});

// Endpoint exclusivo de leitura das coordenadas do RG
app.get('/api/coords-rg', requireAuth, requireAdmin, (req, res) => {
    const filePath = path.join(__dirname, 'assets', 'modelo_rg.template.json');
    res.json(fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : {});
});

// Endpoint exclusivo de gravação - Inteligente (Mescla/Append campos)
app.post('/api/save-coords-rg', requireAuth, requireAdmin, (req, res) => {
    const filePath = path.join(__dirname, 'assets', 'modelo_rg.template.json');
    try {
        if (!fs.existsSync(path.dirname(filePath))) fs.mkdirSync(path.dirname(filePath), { recursive: true });
        
        let currentCoords = {};
        if (fs.existsSync(filePath)) {
            try {
                currentCoords = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            } catch (err) {
                currentCoords = {};
            }
        }
        
        // Mescla campos movidos sem sobrescrever ou deletar o resto
        const novasCoordenadas = { ...currentCoords, ...req.body };
        
        fs.writeFileSync(filePath, JSON.stringify(novasCoordenadas, null, 2));
        res.sendStatus(200);
    } catch (e) {
        res.status(500).send("Erro ao salvar coordenadas do RG.");
    }
});

// Roteamento de Views para o RG
app.get('/gerar-rg', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'private', 'gerar-rg.html'));
});

app.get('/calibrar-rg', requireAuth, requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'private', 'calibrador-rg.html'));
});

// ==================== ROTAS DE INTERFACE PROTEGIDAS (VIEWS) ====================
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

app.get('/bot-admin', requireAuth, requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'private', 'bot-admin.html'));
});

app.get('/loja', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'loja.html'));
});

app.get('/', (req, res) => {
    if (req.session && req.session.user) {
        res.redirect('/home');
    } else {
        res.redirect('/login.html');
    }
});

// ==================== INICIAR SERVIDOR ====================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n==================================================`);
    console.log(`🚀 SERVIDOR COMPLETO INTEGRADO (CRLV & RG ATIVOS)`);
    console.log(`==================================================`);
    console.log(`📍 Local: http://localhost:${PORT}`);
    console.log(`🪪 Painel do RG: /gerar-rg`);
    console.log(`⚙️ Calibrador do RG: /calibrar-rg`);
    console.log(`==================================================\n`);
});
