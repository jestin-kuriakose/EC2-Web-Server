import express from "express"
import mysql from "mysql"
import cors from "cors"
import { PutObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import multer from 'multer'
import dotenv from "dotenv"
import crypto from 'crypto'
import jwt from "jsonwebtoken";
import util from 'util';

dotenv.config()
const app = express();

const randomImageName = (bytes = 32) => crypto.randomBytes(bytes).toString('hex')

const bucketName = process.env.BUCKET_NAME
const bucketRegion = process.env.BUCKET_REGION
const accessKey = process.env.ACCESS_KEY
const secretAccessKey = process.env.SECRET_ACCESS_KEY

const db_host = process.env.DB_HOST
const db_port = process.env.DB_PORT
const db_user = process.env.DB_USER
const db_pass = process.env.DB_PASSWORD
const db_name = process.env.DB_NAME

const storage = multer.memoryStorage()
const upload = multer({storage: storage})

// Connecting to AWS S3
const s3 = new S3Client({
    credentials: {
        accessKeyId: accessKey,
        secretAccessKey: secretAccessKey
    },
    region: bucketRegion
});

// Creating new connection to MySQL DB
const db = mysql.createConnection({
    host: db_host,
    port: db_port,
    user: db_user,
    password: db_pass,
    database: db_name
})

// Checking to see if we are connected to MySQL DB
db.connect((err)=> {
    if(err) {
        throw(err)
    }
    console.log("Connected to DB")
})

app.use(express.json())

app.use(cors())

// Middleware to verify if the user is authenticated
const verify = (req, res, next) => {
    console.log(req.headers.authorization)
    const authHeader = req.headers.authorization

    if(authHeader) {
        const token = authHeader.split(" ")[1]
        jwt.verify(token, "secretKey", (err, user) => {
            if(err) {
                return res.status(403).json("Token is not valid!")
            }
            req.user = user;
            next()
        })
    } else {
        return res.status(401).json("You are not authenticated")
    }
}

app.get('/', (req, res) => {
    res.json("Hi!, This is the Backend !")
})

// Add a book to DB
app.post('/books', upload.single('file'), async (req,res)=> {
    //Uploading image to S3
    let url = '';
    let randomName = randomImageName()

    if(req.file) {
        const params = {
            Bucket: bucketName,
            Key: randomName,
            Body: req.file.buffer,
            ContentType: req.file.mimetype
        }
    
        const command = new PutObjectCommand(params)
    
        await s3.send(command)
    
        //Getting a signed URL from S3 to add to the database. Inserted url to 'image' key in database
        const getObjectParams = {
            Bucket: bucketName,
            Key: randomName
        }
        const getUrlCommand = new GetObjectCommand(getObjectParams);
        url = await getSignedUrl(s3, getUrlCommand, { expiresIn: 3600 });
    }
    

    //Inserting book info to MySQL database
    const q = "INSERT INTO books (`title`,`desc`,`imageUrl`,`imageName`,`price`) VALUES (?)";
    const values = [req.body.title, req.body.desc, url, randomName, req.body.price]

    db.query(q, [values], (err, data) => {
        if(err) return res.json(err)
        return res.json(data)
    })
})

// Fetch all books from DB
app.get('/books', async (req,res)=> {
    let books=[];
    const q = "SELECT * FROM books"
    db.query(q, async(err, data)=>{
        if(err) {
            res.json(err)
            console.log(err)
        }
        
        //Converting the array response from MySql to JSON format
        data?.map((v, index)=> {
            const book = Object.assign({},v)
            books.push(book)
        })

        //Fetching new signed URL from S3 and inserting to converted JSON before sending to frontend
        for(const book of books) {
            if(book.imageUrl) {
                const getObjectParams = {
                    Bucket: bucketName,
                    Key: book.imageName
                }
                const getUrlCommand = new GetObjectCommand(getObjectParams);
                const url =  await getSignedUrl(s3, getUrlCommand, { expiresIn: 3600 });
                book.imageUrl = url
            }
            else {
                book.imageUrl = 'https://s3.us-west-2.amazonaws.com/secure.notion-static.com/668b5c08-0ece-447d-8469-73d4d7b5202a/book-cover.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=AKIAT73L2G45EIPT3X45%2F20230201%2Fus-west-2%2Fs3%2Faws4_request&X-Amz-Date=20230201T075253Z&X-Amz-Expires=86400&X-Amz-Signature=e039f9994b26b0f16cf22cfc491d6a7d8eb1a42bf1ad9238f391bc84f120ae3f&X-Amz-SignedHeaders=host&response-content-disposition=filename%3D%22book-cover.png%22&x-id=GetObject'
            }
            
        }

        books && res.json(books)
    
    })


})

// fetching individual book according to id
app.get('/books/:id', verify, (req,res)=> {
    const bookId = req.params.id
    let books = []
    const q = "SELECT * FROM books where id = ? "
    db.query(q, [bookId], async(err, data)=>{
        if(err) {
            res.json(err)
        }
        //Converting the array response from MySql to JSON format
        data?.map((v, index)=> {
            const book = Object.assign({},v)
            books.push(book)
        })

        //Fetching new signed URL from S3 and inserting to converted JSON before sending to frontend
        for(const book of books) {
            if(book.imageUrl != '') {
                const getObjectParams = {
                    Bucket: bucketName,
                    Key: book.imageName
                }
                const getUrlCommand = new GetObjectCommand(getObjectParams);
                const url =  await getSignedUrl(s3, getUrlCommand, { expiresIn: 3600 });
                book.imageUrl = url
            }
        }
        return res.json(books)
    })
})

// Delete a book from DB
app.delete('/books/:id', verify, (req, res) => {
    const bookId = req.params.id
    const q = "DELETE FROM books WHERE id= ? "

    db.query(q, [bookId], (err, data) => {
        if(err) return res.json(err)
        return res.json(data)
    })
})

// Edit a book in DB
app.put('/books/:id', upload.single('file'), async(req,res) => {

    let url, q, values;
    const bookId = req.params.id;

    //Uploading image to S3
    if(req.file) {
        let randomName = randomImageName()
        const params = {
            Bucket: bucketName,
            Key: randomName,
            Body: req.file.buffer,
            ContentType: req.file.mimetype
        }
    
        const command = new PutObjectCommand(params)
    
        await s3.send(command)
    
        //Getting a signed URL from S3 to add to the database. Inserted url to 'image' key in database
        const getObjectParams = {
            Bucket: bucketName,
            Key: randomName
        }
        const getUrlCommand = new GetObjectCommand(getObjectParams);
        url = await getSignedUrl(s3, getUrlCommand, { expiresIn: 3600 });

        q = "UPDATE books SET `title`= ?, `desc`= ?, `price`= ?, `imageUrl`= ?, `imageName`= ? WHERE id = ?"

        values = [
            req.body.title,
            req.body.desc,
            req.body.price,
            url,
            randomName
          ];

    } else {

        q = "UPDATE books SET `title`= ?, `desc`= ?, `price`= ? WHERE id = ?"

        values = [
            req.body.title,
            req.body.desc,
            req.body.price,
          ];

    }


    db.query(q, [...values, bookId], (err, data) => {
        if (err) {
            console.log(err)
            res.send(err)
        };
        return res.json(data);
    })
})

let refreshTokens = []

app.post("/refresh", (req, res) => {
    const refreshToken = req.body.token
    if(!refreshToken) return res.status(401).json("You are not authenticated")

    if(!refreshTokens.includes(refreshToken)) {
        return res.status(403).json("Refresh token is not valid")
    }

    jwt.verify(refreshToken, "refreshSecretKey", (err,user) => {
        err && console.log(err)
        // refreshTokens = refreshTokens.filter((token)=> token !== refreshToken)

        const newAccessToken = generateAccessToken(user)
        // const newRefreshToken = generateRefreshToken(user)

        // refreshTokens.push(newRefreshToken)

        res.status(200).json({
            accessToken: newAccessToken,
            // refreshToken: newRefreshToken
        })
    })
})

const generateAccessToken = (user) => {
    return jwt.sign({id: user.user_id, isAdmin: user.isAdmin}, "secretKey", {expiresIn: "1m"})
}

const generateRefreshToken = (user) => {
    return jwt.sign({id: user.user_id, isAdmin: user.isAdmin}, "refreshSecretKey")
}

// Register a User
app.post('/register', async (req, res) => {
    const user_name = req.body.name
    const user_email = req.body.email
    const user_password = req.body.password

    const query = util.promisify(db.query).bind(db);

    (async () => {
        try {
            const row = await query(`SELECT * from users where user_email = '${user_email}'`)
            if(!row[0]) {
                const response = await query(`INSERT INTO users (user_email, user_password, user_name) VALUES ('${user_email}', '${user_password}', '${user_name}')`)
                res.status(200).json("User created")
            } else {
                 res.status(401).json("User exists, Login instead")
            }
        } catch (err) {
            res.status(400).json("Server error")
        }
    })()
})

// Login User
app.post('/login', async (req,res) => {
    const email = req.body.email
    const password = req.body.password
    
    const query = util.promisify(db.query).bind(db);

    (async () => {
        try {
            const row = await query(`SELECT * from users where user_email = '${email}'`);
            if(row[0]) {
                const user = await query(`SELECT * from users where user_email = '${email}' AND user_password = '${password}'`)
                if(user[0]) {
                    const accessToken = generateAccessToken(user[0])
                    const refreshToken = generateRefreshToken(user[0])
                    refreshTokens.push(refreshToken)

                    res.json({
                        user_email: user[0].user_email,
                        isAdmin: user[0].isAdmin,
                        user_name: user[0].user_name,
                        accessToken,
                        refreshToken
                    })

                } else {
                    return res.status(403).json("Wrong email or password")
                }
                
            } else {
                res.status(401).json("User doesn't exist")
            }
        } catch(err) {
            console.log(err)
            res.status(400).json("Server error")
        } 
    })();
})

app.post('/logout', (req, res) => {
    const refreshToken = req.body.token
    refreshTokens = refreshTokens.filter(token => token !== refreshToken)
    res.status(200).json("You logged out successfully")
})

app.get('/users', (req, res) => {
    (async() => {
        try{
            const query = util.promisify(db.query).bind(db)
            const users = await query(`SELECT * FROM users`)
            res.status(200).json(users)
        } catch(err) {
            console.log(err)
        }
    })()
})

app.delete("/users/:userId", verify, (req, res) => {
    if (req.user.id === req.params.userId || req.user.isAdmin) {
      res.status(200).json("User has been deleted.");
    } else {
      res.status(403).json("You are not allowed to delete this user!");
    }
  });

app.listen(8800, ()=>{
    console.log("Server connected")
})